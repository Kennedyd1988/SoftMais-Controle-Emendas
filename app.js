import { firebaseConfig } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, updatePassword, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs,
  addDoc, serverTimestamp, orderBy
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const PAPEL_LABEL = { admin: "Administrador", cadastrador: "Cadastrador", controleInterno: "Controle Interno", leitura: "Leitura" };
const ESFERA_LABEL = { federal: "Federal", estadual: "Estadual", municipal: "Municipal" };
const ABAS_CONFIGURAVEIS = ['emendas', 'execucao', 'conformidade', 'acompanhamento', 'relatorios', 'exercicios'];

// ---------- Quesitos de Conformidade (Relatório de Levantamento TCE-RN, item 22+) ----------
// Nível ENTE/EXERCÍCIO: quesitos 1, 2, 3, 4 e 5 do questionário original.
// Como neste app a "página de emendas" é o próprio cadastro (alimenta o
// Portal de Transparência automaticamente), os itens 1-3 são derivados da
// mesma condição: existe pelo menos uma emenda pública, ou há declaração
// negativa válida para o exercício.
function quesitosEnte(ctx) {
  // ctx = { totalPublicas, semEmendasDeclarado, esferaEnte, temEstadual, temMunicipal }
  const secaoOk = ctx.totalPublicas > 0 || ctx.semEmendasDeclarado;
  return [
    { id: 'tem_pagina', label: 'Tem página de emendas', ok: secaoOk },
    { id: 'declaracao_negativa', label: 'Declaração negativa (quando não há emendas)',
      ok: ctx.totalPublicas > 0 ? null : ctx.semEmendasDeclarado },
    { id: 'pagina_sem_dados', label: 'Página não fica vazia sem justificativa', ok: secaoOk },
    { id: 'emendas_estaduais', label: 'Apresenta emendas estaduais', ok: ctx.temEstadual },
    { id: 'emendas_municipais', label: 'Apresenta emendas municipais',
      ok: ctx.esferaEnte === 'estadual' ? null : ctx.temMunicipal },
  ];
}
// Nível EMENDA: quesitos 6 a 16 do questionário original — os 11 campos
// que descrevem uma emenda específica.
function quesitosEmenda(e) {
  return [
    { id: 'identifica_parlamentar', label: 'Identifica parlamentar', ok: !!(e.autorEmenda && e.autorEmenda.trim()) },
    { id: 'identifica_partido', label: 'Identifica partido/unidade', ok: !!(e.partidoUnidade && e.partidoUnidade.trim()) },
    { id: 'distingue_origem', label: 'Distingue origem da emenda', ok: !!e.esfera },
    { id: 'identifica_numero', label: 'Identifica número/código', ok: !!(e.numeroEmenda && e.numeroEmenda.trim()) },
    { id: 'vincula_ato_normativo', label: 'Vincula ao ato normativo', ok: !!(e.atoNormativoOrcamentario && e.atoNormativoOrcamentario.trim()) },
    { id: 'descricao_objeto', label: 'Descrição detalhada do objeto', ok: !!(e.objeto && e.objeto.trim().length >= 10) },
    { id: 'valor_alocado', label: 'Valor alocado', ok: !!(e.valorTotal > 0) },
    { id: 'orgao_executor', label: 'Órgão/entidade executora', ok: !!(e.orgaoEntidadeExecutora && e.orgaoEntidadeExecutora.trim()) },
    { id: 'localidade_beneficiada', label: 'Localidade beneficiada', ok: !!(e.localidadeBeneficiada && e.localidadeBeneficiada.trim()) },
    { id: 'cronograma_execucao', label: 'Cronograma de execução', ok: !!(e.cronogramaFisicoFinanceiro && e.cronogramaFisicoFinanceiro.length > 0) },
    { id: 'instrumentos_vinculados', label: 'Instrumentos vinculados', ok: !!(e.instrumentosVinculados && e.instrumentosVinculados.length > 0) },
  ];
}
// ---------- Quesitos de RASTREABILIDADE (Acórdão, além dos 16 quesitos técnicos) ----------
// O Relatório de Levantamento deixou esses pontos fora do escopo de propósito
// (item 13-15: "verificação substantiva deste quesito não integrou o escopo
// deste levantamento"), mas o Acórdão determina a adequação a eles também.
// Por isso ficam num checklist separado, não misturado aos 16 quesitos
// técnicos originais.
function quesitosRastreabilidade(e) {
  const r = e.resumoExecucao || {};
  return [
    { id: 'beneficiario_final', label: 'Identificação do beneficiário final', ok: !!(e.beneficiarioFinal && e.beneficiarioFinal.trim()) },
    { id: 'metas_previstas', label: 'Metas previstas (quantificadas)', ok: !!(e.metaFisica && e.metaFisica.descricao && e.metaFisica.quantidadePrevista > 0) },
    { id: 'execucao_fisica', label: 'Execução física registrada', ok: (r.qtdEtapas || 0) > 0 && (r.percFisicoAtual || 0) > 0 },
    { id: 'execucao_financeira', label: 'Execução financeira atualizada', ok: (r.totalPago || 0) > 0 || (r.totalLiquidado || 0) > 0 || (r.totalEmpenhado || 0) > 0 },
    { id: 'documentacao_comprobatoria', label: 'Documentação comprobatória anexada', ok: (r.qtdComDocumento || 0) > 0 },
  ];
}
function calcPercent(items) {
  const aplicaveis = items.filter(i => i.ok !== null);
  if (aplicaveis.length === 0) return 100;
  const ok = aplicaveis.filter(i => i.ok === true).length;
  return Math.round((ok / aplicaveis.length) * 1000) / 10;
}

// ---------- estado ----------
const state = {
  user: null, perfil: null,
  entes: [],              // [{id, nome, papel, abas, esferaGoverno}]
  enteAtualId: null,
  enteDados: {},
  emendas: [],
  exercicios: [],          // [{id(ano), bloqueado, semEmendasDeclarado}]
  exercicioSelecionadoEmendas: '',
  exercicioSelecionadoConformidade: '',
  editandoEmendaId: null,
  emendaEmEdicao: null,    // objeto de trabalho (inclui cronograma/instrumentos)
  execucoesAtual: [],
  usuarios: [],
  convites: [],
  telaAtual: 'painel',
  confirmCallback: null,
  logoPendente: undefined, // undefined = não mexeu; null = removida; string = nova (base64)
  editandoUsuarioUid: null,
  editandoUsuarioEmail: null,
};

// ---------- helpers ----------
function $(id) { return document.getElementById(id); }
function fmtBRL(v) { return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast active' + (isError ? ' error' : '');
  setTimeout(() => t.className = 'toast', 2800);
}
function enteAtual() { return state.entes.find(e => e.id === state.enteAtualId); }
function papelAtual() { const en = enteAtual(); return en ? en.papel : null; }
function abasAtual() { const en = enteAtual(); return (en && Array.isArray(en.abas)) ? en.abas : ABAS_CONFIGURAVEIS; }
function temAcessoAba(aba) {
  const p = papelAtual();
  if (p === 'admin') return true;
  if (p === 'controleInterno') return true; // leitura de tudo
  return abasAtual().includes(aba);
}
function podeEditar() { const p = papelAtual(); return p === 'admin' || p === 'cadastrador'; }
function confirmar(titulo, texto, onSim) {
  $('confirmarTitulo').textContent = titulo;
  $('confirmarTexto').textContent = texto;
  state.confirmCallback = onSim;
  $('modalConfirmar').classList.add('active');
}

// ============================================================
// AUTENTICAÇÃO
// ============================================================
let modoSignup = false;
$('btnAuthToggle').addEventListener('click', () => {
  modoSignup = !modoSignup;
  $('loginFields').style.display = modoSignup ? 'none' : 'block';
  $('signupFields').style.display = modoSignup ? 'block' : 'none';
  $('btnAuthSubmit').textContent = modoSignup ? 'Criar conta' : 'Entrar';
  $('authToggleText').textContent = modoSignup ? 'Já tem conta?' : 'Ainda não tem conta?';
  $('btnAuthToggle').textContent = modoSignup ? 'Entrar' : 'Criar conta';
  $('authError').textContent = '';
});
$('btnAuthSubmit').addEventListener('click', async () => {
  $('authError').textContent = '';
  try {
    if (modoSignup) {
      const nome = $('signupNome').value.trim();
      const email = $('signupEmail').value.trim().toLowerCase();
      const senha = $('signupSenha').value;
      if (!nome || !email || senha.length < 6) {
        $('authError').textContent = 'Preencha nome, e-mail e uma senha com pelo menos 6 caracteres.'; return;
      }
      const cred = await createUserWithEmailAndPassword(auth, email, senha);
      await setDoc(doc(db, 'perfis', cred.user.uid), { nome, email, criadoEm: serverTimestamp() });
    } else {
      const email = $('loginEmail').value.trim().toLowerCase();
      const senha = $('loginSenha').value;
      await signInWithEmailAndPassword(auth, email, senha);
    }
  } catch (e) {
    $('authError').textContent = traduzErroAuth(e);
  }
});
function traduzErroAuth(e) {
  const c = e.code || '';
  if (c.includes('user-not-found') || c.includes('wrong-password') || c.includes('invalid-credential')) return 'E-mail ou senha incorretos.';
  if (c.includes('email-already-in-use')) return 'Já existe uma conta com esse e-mail.';
  if (c.includes('weak-password')) return 'Senha muito fraca (mínimo 6 caracteres).';
  if (c.includes('invalid-email')) return 'E-mail inválido.';
  return 'Não foi possível concluir. Tente novamente.';
}
$('btnLogout').addEventListener('click', () => signOut(auth));

onAuthStateChangedHandler();
function onAuthStateChangedHandler() {
  const params = new URLSearchParams(location.search);
  const portalEnteId = params.get('portal');
  if (portalEnteId) {
    $('publicPortal').classList.add('active');
    initPortalPublico(portalEnteId);
    return;
  }
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      state.user = user;
      $('authScreen').classList.remove('active');
      await carregarPerfilEEntes();
      $('appShell').classList.add('active');
      mostrarTela('painel');
    } else {
      state.user = null;
      $('appShell').classList.remove('active');
      $('authScreen').classList.add('active');
    }
  });
}

// ============================================================
// PERFIL / ENTES (multi-tenant)
// ============================================================
async function carregarPerfilEEntes() {
  const perfilRef = doc(db, 'perfis', state.user.uid);
  const perfilSnap = await getDoc(perfilRef);
  if (perfilSnap.exists()) {
    state.perfil = perfilSnap.data();
  } else {
    state.perfil = { nome: state.user.email.split('@')[0], email: state.user.email };
    await setDoc(perfilRef, { ...state.perfil, criadoEm: serverTimestamp() });
  }

  await resgatarConvitesPendentes();

  const idxSnap = await getDocs(query(collection(db, 'membrosIndice'), where('uid', '==', state.user.uid)));
  state.entes = idxSnap.docs.map(d => {
    const v = d.data();
    return { id: v.enteId, nome: v.enteNome, papel: v.papel, abas: v.abas, esferaGoverno: v.esferaGoverno, precisaTrocarSenha: !!v.precisaTrocarSenha };
  });

  if (state.entes.length === 0) {
    abrirModalNovoEnte(true);
    return;
  }
  if (!state.enteAtualId || !state.entes.find(e => e.id === state.enteAtualId)) {
    state.enteAtualId = state.entes[0].id;
  }
  renderEnteSwitch();
  renderSidebarUser();
  await trocarEnte(state.enteAtualId);
  if (state.entes.some(e => e.precisaTrocarSenha)) abrirModalTrocarSenhaObrigatoria();
}

// Verifica se existe convite pendente (em qualquer ente) para o e-mail do
// usuário logado, consultando o índice de nível raiz "convitesIndice"
// (evita collectionGroup, mais simples de proteger nas regras). Se a pessoa
// já tiver acesso ao ente por outro caminho, só descarta o convite antigo
// sem sobrescrever as permissões que ela já tem.
async function resgatarConvitesPendentes() {
  try {
    const q = query(collection(db, 'convitesIndice'), where('email', '==', state.user.email));
    const snaps = await getDocs(q);
    for (const convDoc of snaps.docs) {
      const dados = convDoc.data();
      const enteId = dados.enteId;
      const abas = dados.abas || ABAS_CONFIGURAVEIS;
      const jaMembro = await getDoc(doc(db, 'entes', enteId, 'usuarios', state.user.uid));
      if (!jaMembro.exists()) {
        await setDoc(doc(db, 'entes', enteId, 'usuarios', state.user.uid), {
          uid: state.user.uid, nome: state.perfil.nome, email: state.user.email,
          papel: dados.papel, abasPermitidas: abas, criadoEm: serverTimestamp()
        });
        await setDoc(doc(db, 'membrosIndice', `${enteId}_${state.user.uid}`), {
          uid: state.user.uid, enteId, enteNome: dados.enteNome || '',
          papel: dados.papel, abas, nome: state.perfil.nome, email: state.user.email
        });
      }
      await deleteDoc(doc(db, 'entes', enteId, 'convites', state.user.email));
      await deleteDoc(convDoc.ref);
    }
  } catch (e) { console.warn('Sem convites pendentes:', e.message); }
}
function renderEnteSwitch() {
  const sel = $('enteSwitch');
  sel.innerHTML = state.entes.map(e => `<option value="${e.id}">${e.nome}</option>`).join('');
  sel.value = state.enteAtualId;
}
sel_enteSwitchListener();
function sel_enteSwitchListener() {
  $('enteSwitch').addEventListener('change', (e) => trocarEnte(e.target.value));
}
function renderSidebarUser() {
  $('sidebarUserNome').textContent = state.perfil?.nome || state.user.email;
  $('sidebarPapel').textContent = PAPEL_LABEL[papelAtual()] || '—';
}
function abrirModalTrocarSenhaObrigatoria() {
  $('novaSenhaObrigatoria').value = ''; $('novaSenhaObrigatoriaConfirmar').value = '';
  $('modalTrocarSenha').classList.add('active');
}
$('btnSalvarNovaSenhaObrigatoria').addEventListener('click', async () => {
  const senha = $('novaSenhaObrigatoria').value, confirmacao = $('novaSenhaObrigatoriaConfirmar').value;
  if (senha.length < 6) { toast('A senha precisa ter pelo menos 6 caracteres.', true); return; }
  if (senha !== confirmacao) { toast('As senhas não são iguais.', true); return; }
  const btn = $('btnSalvarNovaSenhaObrigatoria'); btn.disabled = true;
  try {
    await updatePassword(auth.currentUser, senha);
    await Promise.all(state.entes.map(async (en) => {
      try {
        await updateDoc(doc(db, 'entes', en.id, 'usuarios', state.user.uid), { precisaTrocarSenha: false });
        await updateDoc(doc(db, 'membrosIndice', `${en.id}_${state.user.uid}`), { precisaTrocarSenha: false });
      } catch (e) { /* segue mesmo se um ente falhar */ }
    }));
    state.entes.forEach(en => en.precisaTrocarSenha = false);
    $('modalTrocarSenha').classList.remove('active');
    toast('Senha atualizada com sucesso!');
  } catch (e) {
    toast('Erro ao trocar senha: ' + traduzErroAuth(e), true);
  } finally { btn.disabled = false; }
});
async function trocarEnte(enteId) {
  state.enteAtualId = enteId;
  $('enteSwitch').value = enteId;
  renderSidebarUser();
  const enteSnap = await getDoc(doc(db, 'entes', enteId));
  state.enteDados = enteSnap.exists() ? enteSnap.data() : {};
  aplicarLogoSidebar();
  renderSidebarNav();
  await Promise.all([carregarEmendas(), carregarExercicios()]);
  preencherDadosEnteForm();
  mostrarTela(state.telaAtual || 'painel');
}
function renderSidebarNav() {
  document.querySelectorAll('.nav-btn[data-screen]').forEach(btn => {
    const aba = btn.dataset.aba;
    const admin = btn.dataset.admin;
    let visivel = true;
    if (admin && papelAtual() !== 'admin') visivel = false;
    if (aba && !temAcessoAba(aba)) visivel = false;
    btn.style.display = visivel ? '' : 'none';
  });
}

// ---- criar novo ente ----
function abrirModalNovoEnte(obrigatorio) {
  $('neNome').value = ''; $('neEsfera').value = 'municipal'; $('neMunicipio').value = ''; $('neUf').value = 'RN';
  $('btnCancelarNovoEnte').style.display = obrigatorio ? 'none' : '';
  $('modalNovoEnte').classList.add('active');
}
$('btnNovoEnte').addEventListener('click', () => abrirModalNovoEnte(false));
$('btnCancelarNovoEnte').addEventListener('click', () => $('modalNovoEnte').classList.remove('active'));
$('btnSalvarNovoEnte').addEventListener('click', async () => {
  const nome = $('neNome').value.trim();
  const esferaGoverno = $('neEsfera').value;
  const municipio = $('neMunicipio').value.trim();
  const uf = $('neUf').value.trim().toUpperCase();
  if (!nome) { toast('Informe o nome do ente.', true); return; }
  const btn = $('btnSalvarNovoEnte'); btn.disabled = true;
  try {
    const enteRef = await addDoc(collection(db, 'entes'), {
      nome, esferaGoverno, municipio, uf, logo: null, criadoEm: serverTimestamp(), criadoPor: state.user.uid
    });
    await setDoc(doc(db, 'entes', enteRef.id, 'usuarios', state.user.uid), {
      uid: state.user.uid, nome: state.perfil?.nome || state.user.email, email: state.user.email,
      papel: 'admin', abasPermitidas: ABAS_CONFIGURAVEIS, criadoEm: serverTimestamp()
    });
    await setDoc(doc(db, 'membrosIndice', `${enteRef.id}_${state.user.uid}`), {
      uid: state.user.uid, enteId: enteRef.id, enteNome: nome, esferaGoverno,
      papel: 'admin', abas: ABAS_CONFIGURAVEIS, nome: state.perfil?.nome || state.user.email, email: state.user.email
    });
    $('modalNovoEnte').classList.remove('active');
    toast('Ente criado com sucesso!');
    await carregarPerfilEEntes();
  } catch (e) {
    toast('Erro ao criar ente: ' + e.message, true);
  } finally { btn.disabled = false; }
});

// ============================================================
// NAVEGAÇÃO
// ============================================================
document.querySelectorAll('.nav-btn[data-screen]').forEach(btn => {
  btn.addEventListener('click', () => mostrarTela(btn.dataset.screen));
});
$('btnMenuMobile').addEventListener('click', () => $('sidebar').classList.toggle('mobile-open'));
function mostrarTela(id) {
  state.telaAtual = id;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn[data-screen]').forEach(b => b.classList.toggle('active', b.dataset.screen === id));
  const el = $('screen-' + id);
  if (el) el.classList.add('active');
  $('sidebar').classList.remove('mobile-open');
  if (id === 'painel') renderPainel();
  if (id === 'emendas') renderEmendasLista();
  if (id === 'conformidade') renderConformidadeGeral();
  if (id === 'acompanhamento') renderAcompanhamento();
  if (id === 'exercicios') renderExercicios();
  if (id === 'usuarios') renderUsuarios();
  if (id === 'dadosEnte') preencherDadosEnteForm();
}
$('btnAbrirPortalPublico').addEventListener('click', () => {
  window.open(`${location.pathname}?portal=${state.enteAtualId}`, '_blank');
});

// ============================================================
// EMENDAS
// ============================================================
async function carregarEmendas() {
  const snap = await getDocs(collection(db, 'entes', state.enteAtualId, 'emendas'));
  state.emendas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
function emendasFiltradas() {
  const busca = ($('emendasBusca')?.value || '').trim().toLowerCase();
  const esfera = $('emendasFiltroEsfera')?.value || '';
  const exercicio = $('emendasFiltroExercicio')?.value || '';
  return state.emendas.filter(e => {
    if (esfera && e.esfera !== esfera) return false;
    if (exercicio && String(e.exercicio) !== String(exercicio)) return false;
    if (busca) {
      const alvo = `${e.autorEmenda || ''} ${e.objeto || ''} ${e.numeroEmenda || ''}`.toLowerCase();
      if (!alvo.includes(busca)) return false;
    }
    return true;
  }).sort((a, b) => (b.exercicio || 0) - (a.exercicio || 0));
}
function renderFiltroExercicios(selectId, incluirTodos) {
  const anos = [...new Set(state.emendas.map(e => e.exercicio).filter(Boolean))].sort((a, b) => b - a);
  const sel = $(selectId);
  const atual = sel.value;
  sel.innerHTML = (incluirTodos ? '<option value="">Todos os exercícios</option>' : '') +
    anos.map(a => `<option value="${a}">${a}</option>`).join('');
  if (anos.includes(Number(atual)) || atual === '') sel.value = atual;
}
function renderEmendasLista() {
  renderFiltroExercicios('emendasFiltroExercicio', true);
  const lista = emendasFiltradas();
  $('emendasTbody').innerHTML = lista.map(e => {
    const pct = calcPercent(quesitosEmenda(e));
    const cor = pct === 100 ? 'badge-green' : pct >= 50 ? 'badge-amber' : 'badge-red';
    return `<tr>
      <td>${e.numeroEmenda || '—'}</td>
      <td>${ESFERA_LABEL[e.esfera] || e.esfera}</td>
      <td>${e.autorEmenda || '—'}</td>
      <td style="max-width:260px;">${(e.objeto || '—').slice(0, 90)}</td>
      <td class="num">${fmtBRL(e.valorTotal)}</td>
      <td><span class="badge ${cor}">${pct}%</span></td>
      <td><button class="btn btn-sm" data-abrir="${e.id}">Abrir</button></td>
    </tr>`;
  }).join('');
  $('emendasEmpty').style.display = lista.length ? 'none' : 'block';
  document.querySelectorAll('[data-abrir]').forEach(b => b.addEventListener('click', () => abrirEmenda(b.dataset.abrir)));
}
$('emendasBusca')?.addEventListener('input', renderEmendasLista);
$('emendasFiltroEsfera')?.addEventListener('change', renderEmendasLista);
$('emendasFiltroExercicio')?.addEventListener('change', renderEmendasLista);
$('btnNovaEmenda').addEventListener('click', () => abrirEmenda(null));

function novaEmendaVazia() {
  return {
    esfera: 'municipal', exercicio: new Date().getFullYear(), numeroEmenda: '', autorEmenda: '',
    partidoUnidade: '', objeto: '', valorTotal: 0, atoNormativoOrcamentario: '', orgaoEntidadeExecutora: '',
    localidadeBeneficiada: '', beneficiarioFinal: '', prazoEstimadoImplementacao: '',
    metaFisica: { descricao: '', quantidadePrevista: 0, unidade: '' },
    cronogramaFisicoFinanceiro: [], instrumentosVinculados: [],
    resumoExecucao: { totalEmpenhado: 0, totalLiquidado: 0, totalPago: 0, percFisicoAtual: 0, percFinanceiroAtual: 0, qtdEtapas: 0, qtdComDocumento: 0, ultimaQuantidadeRealizada: 0 },
    status: 'cadastrada', publicoTransparencia: false
  };
}
async function abrirEmenda(id) {
  state.editandoEmendaId = id;
  if (id) {
    const existente = state.emendas.find(e => e.id === id);
    state.emendaEmEdicao = JSON.parse(JSON.stringify(existente));
    $('emendaFormTitulo').textContent = 'Editar Emenda';
    $('btnExcluirEmenda').style.display = podeEditar() ? '' : 'none';
    $('cardConformidadeEmenda').style.display = '';
    $('cardRastreabilidadeEmenda').style.display = '';
    $('cardExecucao').style.display = '';
    await carregarExecucoes(id);
  } else {
    state.emendaEmEdicao = novaEmendaVazia();
    $('emendaFormTitulo').textContent = 'Nova Emenda';
    $('btnExcluirEmenda').style.display = 'none';
    $('cardConformidadeEmenda').style.display = 'none';
    $('cardRastreabilidadeEmenda').style.display = 'none';
    $('cardExecucao').style.display = 'none';
    state.execucoesAtual = [];
  }
  preencherFormEmenda();
  const editavel = podeEditar();
  ['fEsfera', 'fExercicio', 'fNumeroEmenda', 'fAutorEmenda', 'fPartidoUnidade', 'fObjeto', 'fValorTotal',
    'fAtoNormativo', 'fOrgaoExecutor', 'fLocalidade', 'fBeneficiarioFinal', 'fPrazoEstimado', 'fMetaDescricao',
    'fMetaQuantidade', 'fMetaUnidade', 'fPublico'].forEach(id => $(id).disabled = !editavel);
  $('btnSalvarEmenda').style.display = editavel ? '' : 'none';
  mostrarTela('emendaForm');
}
$('btnVoltarEmendas').addEventListener('click', () => mostrarTela('emendas'));

function preencherFormEmenda() {
  const e = state.emendaEmEdicao;
  $('fEsfera').value = e.esfera; $('fExercicio').value = e.exercicio; $('fNumeroEmenda').value = e.numeroEmenda;
  $('fAutorEmenda').value = e.autorEmenda; $('fPartidoUnidade').value = e.partidoUnidade;
  $('fObjeto').value = e.objeto; $('fValorTotal').value = e.valorTotal || '';
  $('fAtoNormativo').value = e.atoNormativoOrcamentario; $('fOrgaoExecutor').value = e.orgaoEntidadeExecutora;
  $('fLocalidade').value = e.localidadeBeneficiada; $('fPrazoEstimado').value = e.prazoEstimadoImplementacao || '';
  $('fBeneficiarioFinal').value = e.beneficiarioFinal || '';
  const meta = e.metaFisica || {};
  $('fMetaDescricao').value = meta.descricao || ''; $('fMetaQuantidade').value = meta.quantidadePrevista || ''; $('fMetaUnidade').value = meta.unidade || '';
  $('fPublico').checked = !!e.publicoTransparencia;
  renderCronograma(); renderInstrumentos();
  if (state.editandoEmendaId) renderChecklistEmenda();
}
function lerFormParaEmenda() {
  const e = state.emendaEmEdicao;
  e.esfera = $('fEsfera').value; e.exercicio = Number($('fExercicio').value) || new Date().getFullYear();
  e.numeroEmenda = $('fNumeroEmenda').value.trim(); e.autorEmenda = $('fAutorEmenda').value.trim();
  e.partidoUnidade = $('fPartidoUnidade').value.trim(); e.objeto = $('fObjeto').value.trim();
  e.valorTotal = Number($('fValorTotal').value) || 0; e.atoNormativoOrcamentario = $('fAtoNormativo').value.trim();
  e.orgaoEntidadeExecutora = $('fOrgaoExecutor').value.trim(); e.localidadeBeneficiada = $('fLocalidade').value.trim();
  e.prazoEstimadoImplementacao = $('fPrazoEstimado').value; e.publicoTransparencia = $('fPublico').checked;
  e.beneficiarioFinal = $('fBeneficiarioFinal').value.trim();
  e.metaFisica = { descricao: $('fMetaDescricao').value.trim(), quantidadePrevista: Number($('fMetaQuantidade').value) || 0, unidade: $('fMetaUnidade').value.trim() };
}

// ---- cronograma físico-financeiro (lista dinâmica) ----
function renderCronograma() {
  const lista = state.emendaEmEdicao.cronogramaFisicoFinanceiro || [];
  $('cronogramaLista').innerHTML = lista.map((m, i) => `
    <div class="cronograma-row">
      <div class="field"><input type="text" placeholder="Marco" value="${m.marco || ''}" data-cron-marco="${i}"></div>
      <div class="field"><input type="date" value="${m.dataPrevista || ''}" data-cron-data="${i}"></div>
      <div class="field"><input type="number" placeholder="%" value="${m.percentual || ''}" data-cron-perc="${i}"></div>
      <button class="btn btn-sm btn-danger" data-cron-rm="${i}">✕</button>
    </div>`).join('');
  document.querySelectorAll('[data-cron-marco]').forEach(el => el.addEventListener('input', e => lista[e.target.dataset.cronMarco].marco = e.target.value));
  document.querySelectorAll('[data-cron-data]').forEach(el => el.addEventListener('input', e => lista[e.target.dataset.cronData].dataPrevista = e.target.value));
  document.querySelectorAll('[data-cron-perc]').forEach(el => el.addEventListener('input', e => lista[e.target.dataset.cronPerc].percentual = Number(e.target.value)));
  document.querySelectorAll('[data-cron-rm]').forEach(el => el.addEventListener('click', e => { lista.splice(Number(e.target.dataset.cronRm), 1); renderCronograma(); }));
}
$('btnAddCronograma').addEventListener('click', () => {
  (state.emendaEmEdicao.cronogramaFisicoFinanceiro ||= []).push({ marco: '', dataPrevista: '', percentual: '' });
  renderCronograma();
});
function renderInstrumentos() {
  const lista = state.emendaEmEdicao.instrumentosVinculados || [];
  $('instrumentosLista').innerHTML = lista.map((it, i) => `
    <div class="instrumento-row">
      <div class="field"><input type="text" placeholder="Nº convênio/contrato/termo" value="${it.numero || ''}" data-inst-num="${i}"></div>
      <div class="field"><input type="text" placeholder="Nº processo administrativo" value="${it.processo || ''}" data-inst-proc="${i}"></div>
      <button class="btn btn-sm btn-danger" data-inst-rm="${i}">✕</button>
    </div>`).join('');
  document.querySelectorAll('[data-inst-num]').forEach(el => el.addEventListener('input', e => lista[e.target.dataset.instNum].numero = e.target.value));
  document.querySelectorAll('[data-inst-proc]').forEach(el => el.addEventListener('input', e => lista[e.target.dataset.instProc].processo = e.target.value));
  document.querySelectorAll('[data-inst-rm]').forEach(el => el.addEventListener('click', e => { lista.splice(Number(e.target.dataset.instRm), 1); renderInstrumentos(); }));
}
$('btnAddInstrumento').addEventListener('click', () => {
  (state.emendaEmEdicao.instrumentosVinculados ||= []).push({ numero: '', processo: '' });
  renderInstrumentos();
});

// ---- checklist de conformidade (por emenda) ----
function renderChecklistEmenda() {
  const e = state.emendaEmEdicao;
  const items = quesitosEmenda(e);
  const pct = calcPercent(items);
  $('confBarFill').style.width = pct + '%';
  $('confBarFill').style.background = pct === 100 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)';
  $('confResumoTexto').textContent = `${pct}% dos quesitos aplicáveis atendidos.`;
  $('checklistEmenda').innerHTML = items.map(i => `
    <div class="checklist-item"><span class="checklist-dot ${i.ok === null ? 'dot-na' : i.ok ? 'dot-ok' : 'dot-fail'}"></span>${i.label}</div>
  `).join('');
  $('btnEmitirCertidao').style.display = pct === 100 ? '' : 'none';

  const itemsRastreio = quesitosRastreabilidade(e);
  $('checklistRastreabilidade').innerHTML = itemsRastreio.map(i => `
    <div class="checklist-item"><span class="checklist-dot ${i.ok === null ? 'dot-na' : i.ok ? 'dot-ok' : 'dot-fail'}"></span>${i.label}</div>
  `).join('');
  const meta = e.metaFisica || {};
  const resumo = e.resumoExecucao || {};
  if (meta.descricao && meta.quantidadePrevista > 0) {
    const atingido = resumo.ultimaQuantidadeRealizada || 0;
    const percAtingido = Math.min(100, Math.round((atingido / meta.quantidadePrevista) * 1000) / 10);
    $('metaBarFill').style.width = percAtingido + '%';
    $('metaResumoTexto').textContent = `Meta: ${meta.descricao} — ${atingido} de ${meta.quantidadePrevista} ${meta.unidade || ''} (${percAtingido}% atingido)`;
  } else {
    $('metaBarFill').style.width = '0%';
    $('metaResumoTexto').textContent = 'Sem meta física cadastrada.';
  }
}
$('btnEmitirCertidao').addEventListener('click', () => emitirCertidaoPdf(state.emendaEmEdicao));

// ---- salvar / excluir emenda ----
$('btnSalvarEmenda').addEventListener('click', async () => {
  lerFormParaEmenda();
  const e = state.emendaEmEdicao;
  if (!e.autorEmenda || !e.numeroEmenda || !e.objeto || !e.orgaoEntidadeExecutora || !e.localidadeBeneficiada || !e.atoNormativoOrcamentario || !e.beneficiarioFinal) {
    toast('Preencha os campos obrigatórios (marcados com *).', true); return;
  }
  const btn = $('btnSalvarEmenda'); btn.disabled = true;
  try {
    if (state.editandoEmendaId) {
      await updateDoc(doc(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId), { ...e, atualizadoEm: serverTimestamp() });
      toast('Emenda atualizada!');
    } else {
      const ref = await addDoc(collection(db, 'entes', state.enteAtualId, 'emendas'), { ...e, criadoEm: serverTimestamp() });
      state.editandoEmendaId = ref.id;
      toast('Emenda cadastrada!');
    }
    await carregarEmendas();
    await abrirEmenda(state.editandoEmendaId);
  } catch (err) {
    toast('Erro ao salvar: ' + err.message, true);
  } finally { btn.disabled = false; }
});
$('btnExcluirEmenda').addEventListener('click', () => {
  confirmar('Excluir emenda', 'Isso remove a emenda e todo o histórico de execução dela. Não pode ser desfeito.', async () => {
    await deleteDoc(doc(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId));
    toast('Emenda excluída.');
    await carregarEmendas();
    mostrarTela('emendas');
  });
});

// ============================================================
// EXECUÇÃO FÍSICO-FINANCEIRA (subcoleção da emenda)
// ============================================================
async function carregarExecucoes(emendaId) {
  const snap = await getDocs(query(collection(db, 'entes', state.enteAtualId, 'emendas', emendaId, 'execucoes'), orderBy('data', 'desc')));
  state.execucoesAtual = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderExecucoes();
}
const ETAPA_LABEL = { empenho: 'Empenho', liquidacao: 'Liquidação', pagamento: 'Pagamento' };
function renderExecucoes() {
  const editavel = podeEditar();
  $('execucoesLista').innerHTML = state.execucoesAtual.length ? state.execucoesAtual.map(x => `
    <div class="exec-item">
      <div class="exec-item-head">
        <strong>${ETAPA_LABEL[x.etapa] || x.etapa} — ${fmtBRL(x.valor)}</strong>
        <span class="screen-sub">${x.data ? new Date(x.data + 'T00:00:00').toLocaleDateString('pt-BR') : ''}</span>
      </div>
      <div class="screen-sub">Físico: ${x.percentualFisicoAcumulado ?? '—'}% · Financeiro: ${x.percentualFinanceiroAcumulado ?? '—'}%</div>
      ${x.quantidadeRealizadaAcumulada ? `<div class="screen-sub">Meta física realizada até aqui: ${x.quantidadeRealizadaAcumulada}</div>` : ''}
      ${x.documentoComprobatorioArquivo ? `<div class="screen-sub"><a href="${x.documentoComprobatorioArquivo}" download="${x.documentoComprobatorioNome || 'comprovante'}">📎 ${x.documentoComprobatorioNome || 'Ver comprovante anexado'}</a></div>` : ''}
      ${x.observacoes ? `<div class="screen-sub">${x.observacoes}</div>` : ''}
      <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
        <span class="badge ${x.validadoPorControleInterno ? 'badge-green' : 'badge-amber'}">${x.validadoPorControleInterno ? 'Validado pelo Controle Interno' : 'Aguardando validação'}</span>
        ${papelAtual() === 'controleInterno' && !x.validadoPorControleInterno ? `<button class="btn btn-sm" data-validar="${x.id}">Validar</button>` : ''}
        ${editavel ? `<button class="btn btn-sm btn-danger" data-rm-exec="${x.id}" style="margin-left:auto;">Excluir</button>` : ''}
      </div>
    </div>`).join('') : '<div class="empty-state">Nenhuma etapa lançada ainda.</div>';
  document.querySelectorAll('[data-validar]').forEach(b => b.addEventListener('click', () => validarExecucao(b.dataset.validar)));
  document.querySelectorAll('[data-rm-exec]').forEach(b => b.addEventListener('click', () => excluirExecucao(b.dataset.rmExec)));
}
async function validarExecucao(execId) {
  await updateDoc(doc(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId, 'execucoes', execId), {
    validadoPorControleInterno: true, validadoPor: state.perfil?.nome || state.user.email, validadoEm: serverTimestamp()
  });
  toast('Etapa validada.');
  await carregarExecucoes(state.editandoEmendaId);
}
function excluirExecucao(execId) {
  confirmar('Excluir etapa', 'Remove esse lançamento de execução.', async () => {
    await deleteDoc(doc(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId, 'execucoes', execId));
    toast('Etapa excluída.');
    await carregarExecucoes(state.editandoEmendaId);
    await recomputeResumoExecucao(state.editandoEmendaId);
  });
}
$('btnNovaExecucao').addEventListener('click', () => {
  $('exEtapa').value = 'empenho'; $('exData').value = ''; $('exValor').value = '';
  $('exPercFisico').value = ''; $('exPercFinanceiro').value = ''; $('exQtdRealizada').value = '';
  $('exArquivo').value = ''; $('exArquivoAtual').textContent = ''; $('exObs').value = '';
  $('modalExecucao').classList.add('active');
});
// Lê um arquivo pequeno (comprovante) como base64 direto no navegador — sem
// Storage pago, mesma lógica usada pra logos no app da igreja. Limite baixo
// porque o documento inteiro da emenda tem teto de 1MB no Firestore.
function lerArquivoComoBase64(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 600 * 1024) { reject(new Error('Arquivo maior que 600KB — reduza o tamanho (ex: comprima o PDF/foto) e tente de novo.')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}
$('btnCancelarExecucao').addEventListener('click', () => $('modalExecucao').classList.remove('active'));
$('btnSalvarExecucao').addEventListener('click', async () => {
  const etapa = $('exEtapa').value, data = $('exData').value, valor = Number($('exValor').value);
  if (!data || !valor) { toast('Preencha data e valor.', true); return; }
  const btn = $('btnSalvarExecucao'); btn.disabled = true;
  try {
    let arquivoBase64 = null, arquivoNome = null, arquivoTipo = null;
    const arquivo = $('exArquivo').files[0];
    if (arquivo) {
      arquivoBase64 = await lerArquivoComoBase64(arquivo);
      arquivoNome = arquivo.name; arquivoTipo = arquivo.type;
    }
    const emenda = state.emendas.find(e => e.id === state.editandoEmendaId);
    await addDoc(collection(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId, 'execucoes'), {
      etapa, data, valor, ano: emenda?.exercicio || new Date().getFullYear(),
      percentualFisicoAcumulado: Number($('exPercFisico').value) || 0,
      percentualFinanceiroAcumulado: Number($('exPercFinanceiro').value) || 0,
      quantidadeRealizadaAcumulada: Number($('exQtdRealizada').value) || 0,
      documentoComprobatorioArquivo: arquivoBase64, documentoComprobatorioNome: arquivoNome, documentoComprobatorioTipo: arquivoTipo,
      observacoes: $('exObs').value.trim(),
      validadoPorControleInterno: false, criadoEm: serverTimestamp(), criadoPor: state.user.uid
    });
    $('modalExecucao').classList.remove('active');
    toast('Etapa lançada!');
    await carregarExecucoes(state.editandoEmendaId);
    await recomputeResumoExecucao(state.editandoEmendaId);
  } catch (err) {
    toast(err.message, true);
  } finally { btn.disabled = false; }
});

// Denormaliza os totais de execução no próprio documento da emenda — assim
// o Painel, a Conformidade e o Acompanhamento Consolidado não precisam
// reler todas as subcoleções de execução de cada emenda pra montar a tela.
async function recomputeResumoExecucao(emendaId) {
  const snap = await getDocs(collection(db, 'entes', state.enteAtualId, 'emendas', emendaId, 'execucoes'));
  const execs = snap.docs.map(d => d.data());
  const soma = (etapa) => execs.filter(x => x.etapa === etapa).reduce((s, x) => s + (x.valor || 0), 0);
  const porData = [...execs].sort((a, b) => (a.data || '').localeCompare(b.data || ''));
  const ultimaComFisico = [...porData].reverse().find(x => x.percentualFisicoAcumulado > 0);
  const ultimaComFinanceiro = [...porData].reverse().find(x => x.percentualFinanceiroAcumulado > 0);
  const ultimaComMeta = [...porData].reverse().find(x => x.quantidadeRealizadaAcumulada > 0);
  const resumo = {
    totalEmpenhado: soma('empenho'), totalLiquidado: soma('liquidacao'), totalPago: soma('pagamento'),
    percFisicoAtual: ultimaComFisico ? ultimaComFisico.percentualFisicoAcumulado : 0,
    percFinanceiroAtual: ultimaComFinanceiro ? ultimaComFinanceiro.percentualFinanceiroAcumulado : 0,
    ultimaQuantidadeRealizada: ultimaComMeta ? ultimaComMeta.quantidadeRealizadaAcumulada : 0,
    qtdEtapas: execs.length, qtdComDocumento: execs.filter(x => !!x.documentoComprobatorioArquivo).length,
    atualizadoEm: serverTimestamp()
  };
  await updateDoc(doc(db, 'entes', state.enteAtualId, 'emendas', emendaId), { resumoExecucao: resumo });
  const idx = state.emendas.findIndex(e => e.id === emendaId);
  if (idx >= 0) state.emendas[idx].resumoExecucao = resumo;
  if (state.emendaEmEdicao && state.editandoEmendaId === emendaId) { state.emendaEmEdicao.resumoExecucao = resumo; renderChecklistEmenda(); }
}

// ============================================================
// CONFORMIDADE (visão geral do ente)
// ============================================================
function contextoEnte(exercicioFiltro) {
  const emendasExercicio = exercicioFiltro ? state.emendas.filter(e => String(e.exercicio) === String(exercicioFiltro)) : state.emendas;
  const publicas = emendasExercicio.filter(e => e.publicoTransparencia);
  const exDoc = state.exercicios.find(x => String(x.id) === String(exercicioFiltro));
  return {
    totalPublicas: publicas.length,
    semEmendasDeclarado: exDoc ? !!exDoc.semEmendasDeclarado : false,
    esferaEnte: state.enteDados.esferaGoverno,
    temEstadual: publicas.some(e => e.esfera === 'estadual'),
    temMunicipal: publicas.some(e => e.esfera === 'municipal'),
  };
}
function renderConformidadeGeral() {
  renderFiltroExercicios('conformidadeFiltroExercicio', true);
  const exercicio = $('conformidadeFiltroExercicio').value;
  const lista = exercicio ? state.emendas.filter(e => String(e.exercicio) === String(exercicio)) : state.emendas;

  const enteItems = quesitosEnte(contextoEnte(exercicio));
  const entePct = calcPercent(enteItems);
  const mediasEmendas = lista.map(e => calcPercent(quesitosEmenda(e)));
  const mediaGeral = mediasEmendas.length ? Math.round((mediasEmendas.reduce((a, b) => a + b, 0) / mediasEmendas.length) * 10) / 10 : 0;
  const total100 = mediasEmendas.filter(p => p === 100).length;

  $('conformidadeCards').innerHTML = `
    <div class="card"><div class="kpi-label">Quesitos estruturais do ente</div><div class="kpi-value">${entePct}%</div><div class="kpi-sub">tem página, declaração, abrangência</div></div>
    <div class="card"><div class="kpi-label">Média de conformidade das emendas</div><div class="kpi-value">${mediaGeral}%</div><div class="kpi-sub">${lista.length} emenda(s)</div></div>
    <div class="card"><div class="kpi-label">Emendas 100% conformes</div><div class="kpi-value">${total100}</div><div class="kpi-sub">de ${lista.length}</div></div>`;

  $('conformidadeTbody').innerHTML = lista.map(e => {
    const pct = calcPercent(quesitosEmenda(e));
    const cor = pct === 100 ? 'badge-green' : pct >= 50 ? 'badge-amber' : 'badge-red';
    return `<tr><td>${e.numeroEmenda || '—'} — ${(e.objeto || '').slice(0, 60)}</td><td>${ESFERA_LABEL[e.esfera] || e.esfera}</td>
      <td><span class="badge ${cor}">${pct}%</span></td><td><button class="btn btn-sm" data-abrir2="${e.id}">Ver</button></td></tr>`;
  }).join('');
  $('conformidadeEmpty').style.display = lista.length ? 'none' : 'block';
  document.querySelectorAll('[data-abrir2]').forEach(b => b.addEventListener('click', () => abrirEmenda(b.dataset.abrir2)));
}
$('conformidadeFiltroExercicio')?.addEventListener('change', renderConformidadeGeral);

// ============================================================
// ACOMPANHAMENTO CONSOLIDADO
// ============================================================
function renderAcompanhamento() {
  renderFiltroExercicios('acompFiltroExercicio', true);
  const exercicio = $('acompFiltroExercicio').value;
  const lista = exercicio ? state.emendas.filter(e => String(e.exercicio) === String(exercicio)) : state.emendas;

  const totais = lista.reduce((acc, e) => {
    const r = e.resumoExecucao || {};
    acc.previsto += e.valorTotal || 0; acc.empenhado += r.totalEmpenhado || 0;
    acc.liquidado += r.totalLiquidado || 0; acc.pago += r.totalPago || 0;
    return acc;
  }, { previsto: 0, empenhado: 0, liquidado: 0, pago: 0 });

  $('acompCards').innerHTML = `
    <div class="card"><div class="kpi-label">Valor previsto</div><div class="kpi-value" style="font-size:17px;">${fmtBRL(totais.previsto)}</div></div>
    <div class="card"><div class="kpi-label">Empenhado</div><div class="kpi-value" style="font-size:17px;">${fmtBRL(totais.empenhado)}</div></div>
    <div class="card"><div class="kpi-label">Liquidado</div><div class="kpi-value" style="font-size:17px;">${fmtBRL(totais.liquidado)}</div></div>
    <div class="card"><div class="kpi-label">Pago</div><div class="kpi-value" style="font-size:17px;">${fmtBRL(totais.pago)}</div><div class="kpi-sub">${totais.previsto > 0 ? Math.round(totais.pago / totais.previsto * 1000) / 10 : 0}% do previsto</div></div>`;

  $('acompTbody').innerHTML = lista.map(e => {
    const r = e.resumoExecucao || {};
    const meta = e.metaFisica || {};
    const percMeta = (meta.quantidadePrevista > 0) ? Math.min(100, Math.round(((r.ultimaQuantidadeRealizada || 0) / meta.quantidadePrevista) * 1000) / 10) : null;
    return `<tr>
      <td>${e.numeroEmenda || '—'} — ${(e.objeto || '').slice(0, 40)}</td>
      <td class="num">${fmtBRL(e.valorTotal)}</td>
      <td class="num">${fmtBRL(r.totalEmpenhado)}</td>
      <td class="num">${fmtBRL(r.totalLiquidado)}</td>
      <td class="num">${fmtBRL(r.totalPago)}</td>
      <td class="num">${r.percFisicoAtual || 0}%</td>
      <td class="num">${r.percFinanceiroAtual || 0}%</td>
      <td class="num">${percMeta === null ? '—' : percMeta + '%'}</td>
      <td class="num">${r.qtdComDocumento || 0}/${r.qtdEtapas || 0}</td>
    </tr>`;
  }).join('');
  $('acompEmpty').style.display = lista.some(e => (e.resumoExecucao?.qtdEtapas || 0) > 0) ? 'none' : 'block';
}
$('acompFiltroExercicio')?.addEventListener('change', renderAcompanhamento);

// ============================================================
// PAINEL
// ============================================================
function renderPainel() {
  $('painelSub').textContent = enteAtual()?.nome || '';
  const total = state.emendas.length;
  const valorTotal = state.emendas.reduce((s, e) => s + (e.valorTotal || 0), 0);
  const mediasEmendas = state.emendas.map(e => calcPercent(quesitosEmenda(e)));
  const media = mediasEmendas.length ? Math.round((mediasEmendas.reduce((a, b) => a + b, 0) / mediasEmendas.length) * 10) / 10 : 0;
  const publicas = state.emendas.filter(e => e.publicoTransparencia).length;

  $('painelCards').innerHTML = `
    <div class="card"><div class="kpi-label">Emendas cadastradas</div><div class="kpi-value">${total}</div></div>
    <div class="card"><div class="kpi-label">Valor total alocado</div><div class="kpi-value" style="font-size:18px;">${fmtBRL(valorTotal)}</div></div>
    <div class="card"><div class="kpi-label">Conformidade média</div><div class="kpi-value">${media}%</div></div>
    <div class="card"><div class="kpi-label">Publicadas no portal</div><div class="kpi-value">${publicas}</div><div class="kpi-sub">de ${total}</div></div>`;

  const piores = [...state.emendas].map(e => ({ e, pct: calcPercent(quesitosEmenda(e)) })).sort((a, b) => a.pct - b.pct).slice(0, 5);
  $('painelConformidadeResumo').innerHTML = piores.length ? piores.map(({ e, pct }) => {
    const cor = pct === 100 ? 'badge-green' : pct >= 50 ? 'badge-amber' : 'badge-red';
    return `<div class="checklist-item" style="justify-content:space-between;"><span>${e.numeroEmenda || '—'} — ${(e.objeto || '').slice(0, 50)}</span><span class="badge ${cor}">${pct}%</span></div>`;
  }).join('') : '<div class="empty-state">Cadastre a primeira emenda para ver o diagnóstico aqui.</div>';
}

// ============================================================
// EXERCÍCIOS FINANCEIROS
// ============================================================
async function carregarExercicios() {
  const snap = await getDocs(collection(db, 'entes', state.enteAtualId, 'exerciciosFinanceiros'));
  state.exercicios = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.id - a.id);
}
function renderExercicios() {
  $('exerciciosTbody').innerHTML = state.exercicios.map(x => `
    <tr><td>${x.id}</td>
      <td><label class="checkbox-row"><input type="checkbox" data-ex-bloq="${x.id}" ${x.bloqueado ? 'checked' : ''} ${papelAtual() !== 'admin' ? 'disabled' : ''}> Bloqueado</label></td>
      <td><label class="checkbox-row"><input type="checkbox" data-ex-neg="${x.id}" ${x.semEmendasDeclarado ? 'checked' : ''} ${papelAtual() !== 'admin' ? 'disabled' : ''}> Sem emendas</label></td>
      <td>${papelAtual() === 'admin' ? `<button class="btn btn-sm btn-danger" data-ex-rm="${x.id}">Excluir</button>` : ''}</td></tr>`).join('');
  $('exerciciosEmpty').style.display = state.exercicios.length ? 'none' : 'block';
  document.querySelectorAll('[data-ex-bloq]').forEach(el => el.addEventListener('change', e =>
    updateDoc(doc(db, 'entes', state.enteAtualId, 'exerciciosFinanceiros', e.target.dataset.exBloq), { bloqueado: e.target.checked }).then(() => toast('Atualizado.'))));
  document.querySelectorAll('[data-ex-neg]').forEach(el => el.addEventListener('change', e =>
    updateDoc(doc(db, 'entes', state.enteAtualId, 'exerciciosFinanceiros', e.target.dataset.exNeg), { semEmendasDeclarado: e.target.checked }).then(async () => { toast('Atualizado.'); await carregarExercicios(); })));
  document.querySelectorAll('[data-ex-rm]').forEach(el => el.addEventListener('click', e => confirmar('Excluir exercício', 'Remove o registro de bloqueio/declaração deste ano.', async () => {
    await deleteDoc(doc(db, 'entes', state.enteAtualId, 'exerciciosFinanceiros', e.target.dataset.exRm));
    await carregarExercicios(); renderExercicios();
  })));
}
$('btnNovoExercicio').addEventListener('click', () => { $('neoAno').value = new Date().getFullYear(); $('modalNovoExercicio').classList.add('active'); });
$('btnCancelarNovoExercicio').addEventListener('click', () => $('modalNovoExercicio').classList.remove('active'));
$('btnSalvarNovoExercicio').addEventListener('click', async () => {
  const ano = $('neoAno').value.trim();
  if (!ano) { toast('Informe o ano.', true); return; }
  await setDoc(doc(db, 'entes', state.enteAtualId, 'exerciciosFinanceiros', ano), { bloqueado: false, semEmendasDeclarado: false, criadoEm: serverTimestamp() });
  $('modalNovoExercicio').classList.remove('active');
  toast('Exercício criado!');
  await carregarExercicios(); renderExercicios();
});

// ============================================================
// USUÁRIOS
// ============================================================
async function renderUsuarios() {
  const snap = await getDocs(collection(db, 'entes', state.enteAtualId, 'usuarios'));
  state.usuarios = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  $('usuariosTbody').innerHTML = state.usuarios.map(u => {
    const souEu = u.id === state.user.uid;
    return `<tr><td>${u.nome || '—'}${souEu ? ' (você)' : ''}</td><td>${u.email || '—'}</td><td><span class="badge badge-brand">${PAPEL_LABEL[u.papel] || u.papel}</span></td>
      <td>
        ${papelAtual() === 'admin' ? `<button class="btn btn-sm" data-editar-user="${u.id}">Editar</button>` : ''}
        ${papelAtual() === 'admin' && !souEu ? `<button class="btn btn-sm btn-danger" data-rm-user="${u.id}">Remover</button>` : ''}
      </td></tr>`;
  }).join('');
  $('usuariosEmpty').style.display = state.usuarios.length > 1 ? 'none' : 'block';
  document.querySelectorAll('[data-editar-user]').forEach(b => b.addEventListener('click', () => abrirModalEditarUsuario(state.usuarios.find(u => u.id === b.dataset.editarUser))));
  document.querySelectorAll('[data-rm-user]').forEach(b => b.addEventListener('click', () => confirmar('Remover usuário', 'A pessoa perde acesso a este ente (a conta dela em si não é apagada).', async () => {
    await deleteDoc(doc(db, 'entes', state.enteAtualId, 'usuarios', b.dataset.rmUser));
    await deleteDoc(doc(db, 'membrosIndice', `${state.enteAtualId}_${b.dataset.rmUser}`));
    toast('Usuário removido.'); renderUsuarios();
  })));

  const convitesSnap = await getDocs(collection(db, 'entes', state.enteAtualId, 'convites'));
  state.convites = convitesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  $('convitesLista').innerHTML = state.convites.length ? state.convites.map(c => `
    <div class="checklist-item" style="justify-content:space-between;"><span>${c.email} — <span class="badge badge-brand">${PAPEL_LABEL[c.papel] || c.papel}</span></span>
      <button class="btn btn-sm btn-danger" data-cancelar-convite="${c.id}">Cancelar</button></div>`).join('')
    : '<div class="empty-state">Nenhum convite pendente.</div>';
  document.querySelectorAll('[data-cancelar-convite]').forEach(b => b.addEventListener('click', async () => {
    await deleteDoc(doc(db, 'entes', state.enteAtualId, 'convites', b.dataset.cancelarConvite));
    await deleteDoc(doc(db, 'convitesIndice', `${state.enteAtualId}_${b.dataset.cancelarConvite}`));
    toast('Convite cancelado.'); renderUsuarios();
  }));
}
function gerarSenhaAleatoria() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = ''; for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
$('btnCadastrarUsuario').addEventListener('click', () => {
  $('cuNome').value = ''; $('cuEmail').value = ''; $('cuSenha').value = gerarSenhaAleatoria(); $('cuPapel').value = 'leitura';
  $('cuTrocarSenha').checked = true;
  document.querySelectorAll('#cuAbas input').forEach(c => c.checked = true);
  $('cuResultado').style.display = 'none';
  $('modalCadastrarUsuario').classList.add('active');
});
$('btnGerarSenhaCu').addEventListener('click', () => $('cuSenha').value = gerarSenhaAleatoria());
$('btnFecharCadastrarUsuario').addEventListener('click', () => { $('modalCadastrarUsuario').classList.remove('active'); renderUsuarios(); });
$('btnSalvarCadastrarUsuario').addEventListener('click', async () => {
  const nome = $('cuNome').value.trim(), email = $('cuEmail').value.trim().toLowerCase(), senha = $('cuSenha').value;
  const papel = $('cuPapel').value;
  const abas = [...document.querySelectorAll('#cuAbas input:checked')].map(c => c.value);
  const precisaTrocarSenha = $('cuTrocarSenha').checked;
  if (!nome || !email || senha.length < 6) { toast('Preencha nome, e-mail e senha (mín. 6 caracteres).', true); return; }
  if (email === state.user.email.toLowerCase()) { toast('Você já tem acesso — não é possível cadastrar seu próprio e-mail.', true); return; }
  const jaMembro = await getDocs(query(collection(db, 'entes', state.enteAtualId, 'usuarios'), where('email', '==', email)));
  if (!jaMembro.empty) { toast('Essa pessoa já tem acesso a este ente. Use "Editar" na lista de usuários.', true); return; }
  const btn = $('btnSalvarCadastrarUsuario'); btn.disabled = true;
  const appTemp = initializeApp(firebaseConfig, `criar-usuario-${Date.now()}`);
  const authTemp = getAuth(appTemp);
  try {
    const cred = await createUserWithEmailAndPassword(authTemp, email, senha);
    const novoUid = cred.user.uid;
    await setDoc(doc(db, 'entes', state.enteAtualId, 'usuarios', novoUid), { uid: novoUid, nome, email, papel, abasPermitidas: abas, precisaTrocarSenha, criadoEm: serverTimestamp() });
    await setDoc(doc(db, 'membrosIndice', `${state.enteAtualId}_${novoUid}`), { uid: novoUid, enteId: state.enteAtualId, enteNome: enteAtual()?.nome || '', papel, abas, nome, email, precisaTrocarSenha });
    $('cuResultado').style.display = 'block';
    $('cuResultado').innerHTML = `<strong>Conta criada!</strong> Passe esses dados para ${nome}:<br>E-mail: <strong>${email}</strong><br>Senha: <strong>${senha}</strong><br>Ela já pode entrar direto no app com "Entrar" (não precisa "Criar conta").`;
    toast('Usuário cadastrado!');
    renderUsuarios();
  } catch (e) {
    if ((e.code || '') === 'auth/email-already-in-use') {
      // A pessoa já tem conta própria (de outro ente ou uso anterior). Nesse
      // caso, criamos um convite: quando ela entrar com a conta dela, o
      // acesso libera sozinho (ver resgatarConvitesPendentes).
      try {
        await setDoc(doc(db, 'entes', state.enteAtualId, 'convites', email), { email, papel, abas, criadoPor: state.user.uid, criadoEm: serverTimestamp() });
        await setDoc(doc(db, 'convitesIndice', `${state.enteAtualId}_${email}`), { email, enteId: state.enteAtualId, enteNome: enteAtual()?.nome || '', papel, abas });
        $('cuResultado').style.display = 'block';
        $('cuResultado').innerHTML = `Esse e-mail já tem uma conta no app. Criamos um convite: quando <strong>${email}</strong> entrar com a conta que já tem, o acesso a este ente libera sozinho.`;
        toast('Convite registrado (a pessoa já tinha conta).');
        renderUsuarios();
      } catch (e2) { toast('Erro ao registrar convite: ' + e2.message, true); }
    } else {
      toast('Erro ao cadastrar: ' + traduzErroAuth(e), true);
    }
  } finally {
    try { await signOut(authTemp); } catch (e) {}
    try { await deleteApp(appTemp); } catch (e) {}
    btn.disabled = false;
  }
});

function abrirModalEditarUsuario(u) {
  state.editandoUsuarioUid = u.id; state.editandoUsuarioEmail = u.email;
  $('editUsuarioEmail').textContent = u.email;
  $('editFormNome').value = u.nome || ''; $('editFormPapel').value = u.papel || 'leitura';
  $('editFormTrocarSenha').checked = !!u.precisaTrocarSenha;
  const abas = u.abasPermitidas || ABAS_CONFIGURAVEIS;
  document.querySelectorAll('#editFormAbas input').forEach(c => c.checked = abas.includes(c.value));
  const souEu = u.id === state.user.uid;
  $('editFormPapel').disabled = souEu;
  $('editAvisoSelf').style.display = souEu ? 'block' : 'none';
  $('modalEditarUsuario').classList.add('active');
}
$('btnCancelarEditarUsuario').addEventListener('click', () => $('modalEditarUsuario').classList.remove('active'));
$('btnSalvarEditarUsuario').addEventListener('click', async () => {
  const uid = state.editandoUsuarioUid;
  const souEu = uid === state.user.uid;
  const nome = $('editFormNome').value.trim();
  if (!nome) { toast('Informe o nome.', true); return; }
  const papel = souEu ? 'admin' : $('editFormPapel').value;
  const abas = [...document.querySelectorAll('#editFormAbas input:checked')].map(c => c.value);
  const precisaTrocarSenha = $('editFormTrocarSenha').checked;
  try {
    await updateDoc(doc(db, 'entes', state.enteAtualId, 'usuarios', uid), { nome, papel, abasPermitidas: abas, precisaTrocarSenha });
    await updateDoc(doc(db, 'membrosIndice', `${state.enteAtualId}_${uid}`), { nome, papel, abas, precisaTrocarSenha });
    $('modalEditarUsuario').classList.remove('active');
    toast('Usuário atualizado!');
    if (souEu) { renderSidebarUser(); await carregarPerfilEEntes(); } else { renderUsuarios(); }
  } catch (e) { toast('Erro ao salvar: ' + e.message, true); }
});
$('btnResetSenhaUsuario').addEventListener('click', async () => {
  const email = state.editandoUsuarioEmail;
  confirmar('Redefinir senha', `Enviar e-mail de redefinição de senha para ${email}?`, async () => {
    try { await sendPasswordResetEmail(auth, email); toast('E-mail de redefinição enviado!'); }
    catch (e) { toast('Erro ao enviar: ' + traduzErroAuth(e), true); }
  });
});

// ============================================================
// DADOS DO ENTE
// ============================================================
// Redimensiona a imagem no próprio navegador antes de salvar (evita guardar
// arquivos grandes desnecessários, já que a logo fica como base64 dentro do
// próprio documento do ente — mesma técnica usada no app da igreja).
function redimensionarImagem(file, maxSize = 400, qualidade = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('Selecione um arquivo de imagem.')); return; }
    if (file.size > 8 * 1024 * 1024) { reject(new Error('Imagem muito grande (máx. 8MB).')); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > h) { if (w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; } }
        else { if (h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize; } }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', qualidade));
      };
      img.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}
function atualizarPreviewLogoEnte() {
  const prev = $('deLogoPreview');
  if (state.logoPendente) { prev.src = state.logoPendente; }
  else { prev.removeAttribute('src'); }
}
$('deLogoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try { state.logoPendente = await redimensionarImagem(file); atualizarPreviewLogoEnte(); }
  catch (err) { toast(err.message, true); }
});
$('btnRemoverLogoEnte').addEventListener('click', () => {
  state.logoPendente = null; $('deLogoFile').value = ''; atualizarPreviewLogoEnte();
});

function preencherDadosEnteForm() {
  const d = state.enteDados;
  state.logoPendente = d.logo || null;
  atualizarPreviewLogoEnte();
  $('deNome').value = d.nome || ''; $('deEsfera').value = d.esferaGoverno || 'municipal';
  $('deMunicipio').value = d.municipio || ''; $('deUf').value = d.uf || '';
  $('deNomeRelatorio').value = d.nomeRelatorio || ''; $('deResponsavel').value = d.responsavelExecutivo || '';
  $('deControleInterno').value = d.controleInterno || '';
  const editavel = papelAtual() === 'admin';
  ['deNome', 'deEsfera', 'deMunicipio', 'deUf', 'deNomeRelatorio', 'deResponsavel', 'deControleInterno'].forEach(id => $(id).disabled = !editavel);
  $('deLogoFile').disabled = !editavel;
  $('btnSalvarDadosEnte').style.display = editavel ? '' : 'none';
  $('btnRemoverLogoEnte').style.display = editavel ? '' : 'none';
}
$('btnSalvarDadosEnte').addEventListener('click', async () => {
  const dados = {
    nome: $('deNome').value.trim(), esferaGoverno: $('deEsfera').value, municipio: $('deMunicipio').value.trim(),
    uf: $('deUf').value.trim().toUpperCase(), nomeRelatorio: $('deNomeRelatorio').value.trim(),
    responsavelExecutivo: $('deResponsavel').value.trim(), controleInterno: $('deControleInterno').value.trim(),
    logo: state.logoPendente || null
  };
  await updateDoc(doc(db, 'entes', state.enteAtualId), dados);
  await updateDoc(doc(db, 'membrosIndice', `${state.enteAtualId}_${state.user.uid}`), { enteNome: dados.nome });
  state.enteDados = { ...state.enteDados, ...dados };
  aplicarLogoSidebar();
  toast('Dados do ente salvos!');
  await carregarPerfilEEntes();
});
function aplicarLogoSidebar() {
  const logo = state.enteDados.logo;
  const img = $('sidebarLogoEnte');
  if (img) { if (logo) { img.src = logo; img.style.display = ''; } else { img.style.display = 'none'; } }
}

// ============================================================
// RELATÓRIOS
// ============================================================
$('btnExportarXlsx').addEventListener('click', () => {
  const linhas = state.emendas.map(e => {
    const r = e.resumoExecucao || {}; const meta = e.metaFisica || {};
    return {
      'Nº': e.numeroEmenda, 'Esfera': ESFERA_LABEL[e.esfera] || e.esfera, 'Exercício': e.exercicio,
      'Autor': e.autorEmenda, 'Partido/Unidade': e.partidoUnidade, 'Objeto': e.objeto, 'Valor Total': e.valorTotal,
      'Ato Normativo': e.atoNormativoOrcamentario, 'Órgão Executor': e.orgaoEntidadeExecutora,
      'Localidade Beneficiada': e.localidadeBeneficiada, 'Beneficiário Final': e.beneficiarioFinal,
      'Meta Física': meta.descricao ? `${meta.descricao} (${meta.quantidadePrevista} ${meta.unidade || ''})` : '',
      'Empenhado': r.totalEmpenhado || 0, 'Liquidado': r.totalLiquidado || 0, 'Pago': r.totalPago || 0,
      '% Físico': r.percFisicoAtual || 0, '% Financeiro': r.percFinanceiroAtual || 0,
      'Conformidade Técnica (%)': calcPercent(quesitosEmenda(e)), 'Rastreabilidade (%)': calcPercent(quesitosRastreabilidade(e)),
      'Público no Portal': e.publicoTransparencia ? 'Sim' : 'Não'
    };
  });
  const ws = XLSX.utils.json_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Emendas');
  XLSX.writeFile(wb, `emendas_${(enteAtual()?.nome || 'ente').replace(/\s+/g, '_')}.xlsx`);
});
$('btnExportarPdfConformidade').addEventListener('click', () => {
  const { jsPDF } = window.jspdf;
  const docPdf = new jsPDF();
  docPdf.setFontSize(14);
  docPdf.text(`Relatório de Conformidade — ${enteAtual()?.nome || ''}`, 14, 16);
  docPdf.setFontSize(9);
  docPdf.text(`Resolução nº 034/2025-TCE/RN — gerado em ${new Date().toLocaleDateString('pt-BR')}`, 14, 22);
  const linhas = state.emendas.map(e => [e.numeroEmenda, ESFERA_LABEL[e.esfera] || e.esfera, (e.objeto || '').slice(0, 40), calcPercent(quesitosEmenda(e)) + '%']);
  docPdf.autoTable({ startY: 28, head: [['Nº', 'Esfera', 'Objeto', 'Conformidade']], body: linhas });
  docPdf.save(`conformidade_${(enteAtual()?.nome || 'ente').replace(/\s+/g, '_')}.pdf`);
});
function emitirCertidaoPdf(e) {
  const { jsPDF } = window.jspdf;
  const docPdf = new jsPDF();
  docPdf.setFontSize(15);
  docPdf.text('Certidão de Regularidade — Emenda Parlamentar', 14, 20);
  docPdf.setFontSize(10);
  const linhas = [
    `Ente: ${enteAtual()?.nome || ''}`, `Emenda nº: ${e.numeroEmenda}`, `Autor: ${e.autorEmenda} (${e.partidoUnidade || '—'})`,
    `Objeto: ${e.objeto}`, `Valor: ${fmtBRL(e.valorTotal)}`, `Ato normativo: ${e.atoNormativoOrcamentario}`,
    `Órgão executor: ${e.orgaoEntidadeExecutora}`, `Localidade beneficiada: ${e.localidadeBeneficiada}`,
    '', 'Certifica-se que esta emenda atende a 100% dos quesitos de transparência ativa', 'previstos na Resolução nº 034/2025-TCE/RN, com base nos dados registrados neste sistema.',
    '', `Emitido em: ${new Date().toLocaleDateString('pt-BR')}`
  ];
  let y = 34;
  linhas.forEach(l => { docPdf.text(l, 14, y); y += 7; });
  docPdf.save(`certidao_emenda_${e.numeroEmenda}.pdf`);
}

// ============================================================
// MODAL DE CONFIRMAÇÃO GENÉRICO
// ============================================================
$('btnConfirmarNao').addEventListener('click', () => { $('modalConfirmar').classList.remove('active'); state.confirmCallback = null; });
$('btnConfirmarSim').addEventListener('click', async () => {
  const cb = state.confirmCallback;
  $('modalConfirmar').classList.remove('active'); state.confirmCallback = null;
  if (cb) await cb();
});

// ============================================================
// PORTAL DE TRANSPARÊNCIA (público, sem login)
// ============================================================
async function initPortalPublico(enteId) {
  const enteSnap = await getDoc(doc(db, 'entes', enteId));
  if (!enteSnap.exists()) { $('portalEnteNome').textContent = 'Ente não encontrado.'; return; }
  const enteDados = enteSnap.data();
  if (enteDados.logo) { $('portalLogo').src = enteDados.logo; $('portalLogo').style.maxHeight = '90px'; }
  $('portalEnteNome').textContent = `Portal de Transparência — ${enteDados.nome}`;
  $('portalEnteSub').textContent = `${enteDados.esferaGoverno === 'estadual' ? 'Governo Estadual' : 'Prefeitura Municipal'}${enteDados.uf ? ' · ' + enteDados.uf : ''}`;

  const snap = await getDocs(query(collection(db, 'entes', enteId, 'emendas'), where('publicoTransparencia', '==', true)));
  const emendas = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const anos = [...new Set(emendas.map(e => e.exercicio).filter(Boolean))].sort((a, b) => b - a);
  $('portalFiltroExercicio').innerHTML = '<option value="">Todos os exercícios</option>' + anos.map(a => `<option value="${a}">${a}</option>`).join('');

  function render() {
    const exercicio = $('portalFiltroExercicio').value, esfera = $('portalFiltroEsfera').value;
    const busca = $('portalBusca').value.trim().toLowerCase();
    const lista = emendas.filter(e => {
      if (exercicio && String(e.exercicio) !== String(exercicio)) return false;
      if (esfera && e.esfera !== esfera) return false;
      if (busca && !`${e.autorEmenda} ${e.objeto} ${e.numeroEmenda}`.toLowerCase().includes(busca)) return false;
      return true;
    });
    const r = (e) => e.resumoExecucao || {};
    const m = (e) => e.metaFisica || {};
    $('portalLista').innerHTML = lista.length ? lista.map(e => `
      <div class="publico-emenda">
        <h3>${e.numeroEmenda || '—'} — ${e.objeto || 'Sem objeto informado'}</h3>
        <dl class="publico-grid">
          <div><dt>Esfera</dt><dd>${ESFERA_LABEL[e.esfera] || e.esfera}</dd></div>
          <div><dt>Exercício</dt><dd>${e.exercicio || '—'}</dd></div>
          <div><dt>Autor / Parlamentar</dt><dd>${e.autorEmenda || '—'}</dd></div>
          <div><dt>Partido/Unidade</dt><dd>${e.partidoUnidade || '—'}</dd></div>
          <div><dt>Valor</dt><dd>${fmtBRL(e.valorTotal)}</dd></div>
          <div><dt>Ato normativo</dt><dd>${e.atoNormativoOrcamentario || '—'}</dd></div>
          <div><dt>Órgão executor</dt><dd>${e.orgaoEntidadeExecutora || '—'}</dd></div>
          <div><dt>Localidade beneficiada</dt><dd>${e.localidadeBeneficiada || '—'}</dd></div>
          <div><dt>Beneficiário final</dt><dd>${e.beneficiarioFinal || '—'}</dd></div>
          <div><dt>Execução física</dt><dd>${r(e).percFisicoAtual || 0}%</dd></div>
          <div><dt>Execução financeira</dt><dd>${r(e).percFinanceiroAtual || 0}% (${fmtBRL(r(e).totalPago)} pago)</dd></div>
          <div><dt>Meta física</dt><dd>${m(e).descricao ? `${m(e).descricao}: ${r(e).ultimaQuantidadeRealizada || 0} de ${m(e).quantidadePrevista} ${m(e).unidade || ''}` : '—'}</dd></div>
        </dl>
        <button class="btn btn-sm" style="margin-top:12px;" data-ver-exec="${e.id}">Ver histórico de execução e documentos</button>
        <div id="portalExec-${e.id}" style="margin-top:10px;"></div>
      </div>`).join('') : '<div class="empty-state">Nenhuma emenda pública encontrada para este filtro.</div>';

    document.querySelectorAll('[data-ver-exec]').forEach(btn => btn.addEventListener('click', async () => {
      const alvo = $('portalExec-' + btn.dataset.verExec);
      if (alvo.dataset.carregado) { alvo.style.display = alvo.style.display === 'none' ? '' : 'none'; return; }
      const snapExec = await getDocs(query(collection(db, 'entes', enteId, 'emendas', btn.dataset.verExec, 'execucoes'), orderBy('data', 'desc')));
      const execs = snapExec.docs.map(d => d.data());
      alvo.innerHTML = execs.length ? execs.map(x => `
        <div class="exec-item">
          <div class="exec-item-head"><strong>${ETAPA_LABEL_PORTAL[x.etapa] || x.etapa} — ${fmtBRL(x.valor)}</strong>
            <span class="screen-sub">${x.data ? new Date(x.data + 'T00:00:00').toLocaleDateString('pt-BR') : ''}</span></div>
          ${x.documentoComprobatorioArquivo ? `<a href="${x.documentoComprobatorioArquivo}" download="${x.documentoComprobatorioNome || 'comprovante'}">📎 ${x.documentoComprobatorioNome || 'Comprovante'}</a>` : '<span class="screen-sub">Sem documento anexado</span>'}
        </div>`).join('') : '<div class="empty-state">Nenhuma etapa de execução lançada ainda.</div>';
      alvo.dataset.carregado = '1';
    }));
  }
  $('portalFiltroExercicio').addEventListener('change', render);
  $('portalFiltroEsfera').addEventListener('change', render);
  $('portalBusca').addEventListener('input', render);
  render();
}
const ETAPA_LABEL_PORTAL = { empenho: 'Empenho', liquidacao: 'Liquidação', pagamento: 'Pagamento' };
