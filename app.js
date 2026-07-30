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
    { id: 'metas_previstas', label: 'Metas previstas (quantificadas)', ok: !!(e.metas && e.metas.length > 0 && e.metas.every(m => m.descricao && m.quantidadePrevista > 0)) },
    { id: 'execucao_fisica', label: 'Execução física registrada', ok: (r.qtdDespesas || 0) > 0 && (r.percFisicoAtual || 0) > 0 },
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
  despesasAtual: [],
  receitasAtual: [],
  editandoDespesaId: null,
  editandoReceitaId: null,
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

// ---- Importação/exportação em lote de emendas ----
const COLUNAS_IMPORT_EMENDA = ['ESFERA', 'EXERCICIO', 'NUMERO_EMENDA', 'AUTOR', 'PARTIDO_UNIDADE', 'OBJETO', 'VALOR_TOTAL', 'ATO_NORMATIVO', 'ORGAO_EXECUTOR', 'LOCALIDADE_BENEFICIADA', 'BENEFICIARIO_FINAL', 'BANCO', 'AGENCIA', 'CONTA', 'TIPO_CONTA'];
$('btnModeloEmendas').addEventListener('click', () => {
  const exemplo = {
    ESFERA: 'municipal', EXERCICIO: 2026, NUMERO_EMENDA: '0001/2026', AUTOR: 'Nome do parlamentar',
    PARTIDO_UNIDADE: 'PARTIDO/UF', OBJETO: 'Descrição do objeto da emenda', VALOR_TOTAL: 100000,
    ATO_NORMATIVO: 'LOA 2026, art. 12', ORGAO_EXECUTOR: 'Secretaria Municipal de Obras',
    LOCALIDADE_BENEFICIADA: 'Sede do município', BENEFICIARIO_FINAL: 'Escola Municipal X',
    BANCO: 'Banco do Brasil', AGENCIA: '1234-5', CONTA: '67890-1', TIPO_CONTA: 'corrente'
  };
  const ws = XLSX.utils.json_to_sheet([exemplo], { header: COLUNAS_IMPORT_EMENDA });
  const wsInstrucoes = XLSX.utils.aoa_to_sheet([
    ['Instruções para importação de emendas'], [''],
    ['Preencha uma linha por emenda. Uma emenda já existente (mesmo NUMERO_EMENDA + EXERCICIO) não é importada de novo.'],
    ['ESFERA = federal, estadual ou municipal'], ['EXERCICIO = ano do exercício financeiro'],
    ['NUMERO_EMENDA = número/código da emenda'], ['AUTOR = nome do parlamentar proponente'],
    ['PARTIDO_UNIDADE = partido/unidade do parlamentar'], ['OBJETO = descrição do objeto'],
    ['VALOR_TOTAL = valor alocado (número, sem R$)'], ['ATO_NORMATIVO = LOA/crédito adicional vinculado'],
    ['ORGAO_EXECUTOR = órgão/entidade executora'], ['LOCALIDADE_BENEFICIADA = município/bairro/órgão beneficiado'],
    ['BENEFICIARIO_FINAL = quem recebe o recurso de fato'],
    ['BANCO, AGENCIA, CONTA, TIPO_CONTA = dados bancários (opcional; TIPO_CONTA = corrente, poupanca ou especifica)'],
    ['Metas físicas, cronograma e instrumentos vinculados não vêm da planilha — cadastre depois, direto na emenda.'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsInstrucoes, 'Instruções');
  XLSX.utils.book_append_sheet(wb, ws, 'Emendas');
  XLSX.writeFile(wb, 'modelo_importacao_emendas.xlsx');
});
$('btnImportarEmendas').addEventListener('click', () => $('emImportarArquivo').click());
$('emImportarArquivo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const log = $('importEmendasLog');
  log.style.display = 'block'; log.textContent = 'Lendo planilha...\n';
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames.includes('Emendas') ? 'Emendas' : wb.SheetNames[0]];
    const linhas = XLSX.utils.sheet_to_json(ws, { defval: '' }).map(obj => {
      const norm = {}; Object.entries(obj).forEach(([k, v]) => norm[String(k).trim().toUpperCase()] = v); return norm;
    });
    if (!linhas.length) { log.textContent += 'Planilha vazia.'; return; }
    const existentes = new Set(state.emendas.map(em => `${em.numeroEmenda}|${em.exercicio}`.toLowerCase()));
    let criadas = 0, duplicadas = 0, comErro = 0;
    for (const linha of linhas) {
      const numeroEmenda = String(linha.NUMERO_EMENDA || '').trim();
      const exercicio = Number(linha.EXERCICIO) || new Date().getFullYear();
      if (!numeroEmenda) { comErro++; continue; }
      const chave = `${numeroEmenda}|${exercicio}`.toLowerCase();
      if (existentes.has(chave)) { duplicadas++; continue; }
      try {
        const nova = novaEmendaVazia();
        Object.assign(nova, {
          esfera: (String(linha.ESFERA || 'municipal').trim().toLowerCase()) || 'municipal', exercicio, numeroEmenda,
          autorEmenda: String(linha.AUTOR || '').trim(), partidoUnidade: String(linha.PARTIDO_UNIDADE || '').trim(),
          objeto: String(linha.OBJETO || '').trim(), valorTotal: Number(linha.VALOR_TOTAL) || 0,
          atoNormativoOrcamentario: String(linha.ATO_NORMATIVO || '').trim(), orgaoEntidadeExecutora: String(linha.ORGAO_EXECUTOR || '').trim(),
          localidadeBeneficiada: String(linha.LOCALIDADE_BENEFICIADA || '').trim(), beneficiarioFinal: String(linha.BENEFICIARIO_FINAL || '').trim(),
          dadosBancarios: { banco: String(linha.BANCO || '').trim(), agencia: String(linha.AGENCIA || '').trim(), conta: String(linha.CONTA || '').trim(), tipoConta: String(linha.TIPO_CONTA || '').trim() },
        });
        delete nova.id;
        await addDoc(collection(db, 'entes', state.enteAtualId, 'emendas'), { ...nova, criadoEm: serverTimestamp(), origemImportacao: true });
        existentes.add(chave);
        criadas++;
      } catch (err) { comErro++; }
    }
    log.textContent += `Concluído: ${criadas} emenda(s) importada(s), ${duplicadas} já existiam (ignoradas), ${comErro} com erro/sem número.`;
    toast(`Importação concluída: ${criadas} emenda(s) nova(s).`);
    await carregarEmendas();
    renderEmendasLista();
  } catch (err) {
    log.textContent += 'Erro: ' + err.message;
  } finally {
    $('emImportarArquivo').value = '';
  }
});

function novaEmendaVazia() {
  return {
    esfera: 'municipal', exercicio: new Date().getFullYear(), numeroEmenda: '', autorEmenda: '',
    partidoUnidade: '', objeto: '', valorTotal: 0, atoNormativoOrcamentario: '', orgaoEntidadeExecutora: '',
    localidadeBeneficiada: '', beneficiarioFinal: '', prazoEstimadoImplementacao: '',
    dadosBancarios: { banco: '', agencia: '', conta: '', tipoConta: '' },
    metas: [],
    cronogramaFisicoFinanceiro: [], instrumentosVinculados: [], anexos: [],
    resumoExecucao: { totalEmpenhado: 0, totalLiquidado: 0, totalPago: 0, totalReceita: 0, percFisicoAtual: 0, percFinanceiroAtual: 0, qtdDespesas: 0, qtdReceitas: 0, qtdComDocumento: 0, metas: [] },
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
    $('cardDespesas').style.display = '';
    $('cardReceitas').style.display = '';
    await Promise.all([carregarDespesas(id), carregarReceitas(id)]);
  } else {
    state.emendaEmEdicao = novaEmendaVazia();
    $('emendaFormTitulo').textContent = 'Nova Emenda';
    $('btnExcluirEmenda').style.display = 'none';
    $('cardConformidadeEmenda').style.display = 'none';
    $('cardRastreabilidadeEmenda').style.display = 'none';
    $('cardDespesas').style.display = 'none';
    $('cardReceitas').style.display = 'none';
    state.despesasAtual = []; state.receitasAtual = [];
  }
  preencherFormEmenda();
  const editavel = podeEditar();
  ['fEsfera', 'fExercicio', 'fNumeroEmenda', 'fAutorEmenda', 'fPartidoUnidade', 'fObjeto', 'fValorTotal',
    'fAtoNormativo', 'fOrgaoExecutor', 'fLocalidade', 'fBeneficiarioFinal', 'fPrazoEstimado', 'fPublico',
    'fBancoNome', 'fBancoAgencia', 'fBancoConta', 'fBancoTipoConta', 'fAnexosArquivo'].forEach(id => $(id).disabled = !editavel);
  $('btnSalvarEmenda').style.display = editavel ? '' : 'none';
  mostrarTela('emendaForm');
}
$('btnVoltarEmendas').addEventListener('click', () => mostrarTela('emendas'));

function preencherFormEmenda() {
  const e = state.emendaEmEdicao;
  $('fAnexosHint').textContent = (state.enteDados.googleDrive && state.enteDados.googleDrive.clientId)
    ? 'Pode selecionar vários arquivos de uma vez — vão direto pro Google Drive configurado (sem limite de 650KB).'
    : 'Pode selecionar vários arquivos de uma vez — limite de ~650KB no total (sem Google Drive configurado para o ente).';
  $('fEsfera').value = e.esfera; $('fExercicio').value = e.exercicio; $('fNumeroEmenda').value = e.numeroEmenda;
  $('fAutorEmenda').value = e.autorEmenda; $('fPartidoUnidade').value = e.partidoUnidade;
  $('fObjeto').value = e.objeto; $('fValorTotal').value = e.valorTotal || '';
  $('fAtoNormativo').value = e.atoNormativoOrcamentario; $('fOrgaoExecutor').value = e.orgaoEntidadeExecutora;
  $('fLocalidade').value = e.localidadeBeneficiada; $('fPrazoEstimado').value = e.prazoEstimadoImplementacao || '';
  $('fBeneficiarioFinal').value = e.beneficiarioFinal || '';
  const banco = e.dadosBancarios || {};
  $('fBancoNome').value = banco.banco || ''; $('fBancoAgencia').value = banco.agencia || '';
  $('fBancoConta').value = banco.conta || ''; $('fBancoTipoConta').value = banco.tipoConta || '';
  $('fPublico').checked = !!e.publicoTransparencia;
  renderCronograma(); renderInstrumentos(); renderMetas(); renderAnexosEmenda();
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
  e.dadosBancarios = {
    banco: $('fBancoNome').value.trim(), agencia: $('fBancoAgencia').value.trim(),
    conta: $('fBancoConta').value.trim(), tipoConta: $('fBancoTipoConta').value
  };
  // e.metas já vem atualizado direto pelos campos da lista dinâmica (ver renderMetas)
}

// ---- metas físicas (lista dinâmica, uma emenda pode ter várias) ----
function idCurto() { return Math.random().toString(36).slice(2, 10); }
function renderMetas() {
  const lista = state.emendaEmEdicao.metas || [];
  $('metasLista').innerHTML = lista.map((m, i) => `
    <div class="cronograma-row">
      <div class="field"><input type="text" placeholder="Descrição da meta (ex: famílias atendidas)" value="${m.descricao || ''}" data-meta-desc="${i}"></div>
      <div class="field" style="max-width:120px;"><input type="number" step="0.01" placeholder="Quantidade" value="${m.quantidadePrevista || ''}" data-meta-qtd="${i}"></div>
      <div class="field" style="max-width:110px;"><input type="text" placeholder="Unidade" value="${m.unidade || ''}" data-meta-un="${i}"></div>
      <button class="btn btn-sm btn-danger" data-meta-rm="${i}">✕</button>
    </div>`).join('');
  document.querySelectorAll('[data-meta-desc]').forEach(el => el.addEventListener('input', e => lista[e.target.dataset.metaDesc].descricao = e.target.value));
  document.querySelectorAll('[data-meta-qtd]').forEach(el => el.addEventListener('input', e => lista[e.target.dataset.metaQtd].quantidadePrevista = Number(e.target.value) || 0));
  document.querySelectorAll('[data-meta-un]').forEach(el => el.addEventListener('input', e => lista[e.target.dataset.metaUn].unidade = e.target.value));
  document.querySelectorAll('[data-meta-rm]').forEach(el => el.addEventListener('click', e => { lista.splice(Number(e.target.dataset.metaRm), 1); renderMetas(); }));
}
$('btnAddMeta').addEventListener('click', () => {
  (state.emendaEmEdicao.metas ||= []).push({ id: idCurto(), descricao: '', quantidadePrevista: 0, unidade: '' });
  renderMetas();
});

// ---- documentos anexados à emenda (múltiplos arquivos) ----
function renderAnexosEmenda() {
  const lista = state.emendaEmEdicao.anexos || [];
  $('fAnexosLista').innerHTML = lista.length ? lista.map((a, i) => `
    <div class="anexos-lista-item">
      <span>📎 ${a.nome} ${a.tamanho ? `(${Math.round(a.tamanho / 1024)}KB)` : ''}</span>
      <button class="btn btn-sm btn-danger" type="button" data-anexo-rm="${i}">Remover</button>
    </div>`).join('') : '';
  document.querySelectorAll('[data-anexo-rm]').forEach(b => b.addEventListener('click', () => {
    lista.splice(Number(b.dataset.anexoRm), 1);
    renderAnexosEmenda();
  }));
}
// Soma o tamanho dos anexos já salvos como base64 nesta emenda — usado pra
// não deixar o documento inteiro estourar o limite de 1MB do Firestore
// quando o ente não tem Google Drive configurado.
function tamanhoTotalAnexosBase64() {
  return (state.emendaEmEdicao.anexos || []).reduce((s, a) => s + (a.arquivo ? (a.tamanho || 0) : 0), 0);
}
$('fAnexosArquivo').addEventListener('change', async (e) => {
  const arquivos = [...e.target.files];
  if (!arquivos.length) return;
  const usaDrive = !!(state.enteDados.googleDrive && state.enteDados.googleDrive.clientId);
  for (const [i, arquivo] of arquivos.entries()) {
    if (!usaDrive && (tamanhoTotalAnexosBase64() + arquivo.size) > 650 * 1024) {
      toast(`"${arquivo.name}" não coube no limite de anexos sem Google Drive (~650KB no total). Configure o Drive em Dados do Ente pra anexar mais.`, true);
      continue;
    }
    const linhaId = `fAnexoProgresso-${i}-${Date.now()}`;
    $('fAnexosProgresso').insertAdjacentHTML('beforeend', `
      <div class="upload-progress active upload-progress-item" id="${linhaId}">
        <div class="upload-progress-row"><span>${arquivo.name}</span><span class="pct">0%</span></div>
        <div class="upload-progress-track"><div class="upload-progress-fill" style="width:0%;"></div></div>
      </div>`);
    const linha = document.getElementById(linhaId);
    try {
      const resultado = await processarAnexo(arquivo, (pct) => {
        linha.querySelector('.pct').textContent = pct + '%';
        linha.querySelector('.upload-progress-fill').style.width = pct + '%';
      });
      (state.emendaEmEdicao.anexos ||= []).push({
        id: idCurto(), nome: arquivo.name, tamanho: arquivo.size, tipo: arquivo.type,
        arquivo: resultado.documentoComprobatorioArquivo || null,
        driveLink: resultado.documentoDriveLink || null, driveNome: resultado.documentoDriveNome || null
      });
      renderAnexosEmenda();
    } catch (err) {
      toast(`Erro ao anexar "${arquivo.name}": ${err.message}`, true);
    } finally {
      linha.remove();
    }
  }
  $('fAnexosArquivo').value = '';
});

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
  const metas = e.metas || [];
  const resumoMetas = (e.resumoExecucao && e.resumoExecucao.metas) || [];
  if (metas.length) {
    $('metasResumoLista').innerHTML = metas.map(m => {
      const r = resumoMetas.find(x => x.id === m.id) || {};
      const realizado = r.quantidadeRealizada || 0;
      const pctM = m.quantidadePrevista > 0 ? Math.min(100, Math.round((realizado / m.quantidadePrevista) * 1000) / 10) : 0;
      return `<div style="margin-bottom:10px;">
        <div class="screen-sub">${m.descricao || 'Meta sem descrição'} — ${realizado} de ${m.quantidadePrevista || 0} ${m.unidade || ''} (${pctM}% atingido)</div>
        <div class="conf-bar-track"><div class="conf-bar-fill" style="width:${pctM}%; background:var(--cyan);"></div></div>
      </div>`;
    }).join('');
  } else {
    $('metasResumoLista').innerHTML = '<div class="screen-sub">Sem metas físicas cadastradas.</div>';
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
// DESPESAS (empenho+liquidação+pagamento num registro só) e RECEITAS
// subcoleções da emenda
// ============================================================
async function carregarDespesas(emendaId) {
  const snap = await getDocs(query(collection(db, 'entes', state.enteAtualId, 'emendas', emendaId, 'despesas'), orderBy('dataPagamento', 'desc')));
  state.despesasAtual = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderDespesas();
}
async function carregarReceitas(emendaId) {
  const snap = await getDocs(query(collection(db, 'entes', state.enteAtualId, 'emendas', emendaId, 'receitas'), orderBy('data', 'desc')));
  state.receitasAtual = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderReceitas();
}
function statusDespesa(x) { return (x.valorPago > 0) ? 'Liquidada/Paga' : 'Empenhada'; }
function linkDocumento(x) {
  if (x.documentoComprobatorioArquivo) return `<a class="fin-doc-link" href="${x.documentoComprobatorioArquivo}" download="${x.documentoComprobatorioNome || 'comprovante'}">📎 ${x.documentoComprobatorioNome || 'Ver comprovante'}</a>`;
  if (x.documentoDriveLink) return `<a class="fin-doc-link" href="${x.documentoDriveLink}" target="_blank" rel="noopener">📎 ${x.documentoDriveNome || 'Ver no Google Drive'}</a>`;
  return `<span class="fin-doc-empty">Sem documento anexado</span>`;
}
function renderDespesas() {
  const editavel = podeEditar();
  const emenda = state.emendas.find(e => e.id === state.editandoEmendaId) || {};
  const metasPorId = Object.fromEntries((emenda.metas || []).map(m => [m.id, m]));
  $('despesasLista').innerHTML = state.despesasAtual.length ? state.despesasAtual.map(x => {
    const metasTxt = (x.metasVinculadas || []).map(mv => {
      const m = metasPorId[mv.metaId];
      return `Meta "${m ? m.descricao : mv.metaId}": +${mv.quantidade} ${m ? m.unidade || '' : ''}`;
    }).join(' · ');
    return `<div class="fin-card">
      <div class="fin-card-head">
        <div>
          <div class="fin-card-title">Empenho ${x.numeroEmpenho || '—'} — ${x.credorNome || 'sem credor'}</div>
          <div class="fin-card-sub">${x.credorCnpj || ''}</div>
        </div>
        <div>
          <div class="fin-card-value">${fmtBRL(x.valorPago || x.valorEmpenho)}</div>
          <div class="fin-card-date">${x.dataPagamento ? new Date(x.dataPagamento + 'T00:00:00').toLocaleDateString('pt-BR') : ''}</div>
        </div>
      </div>
      <span class="badge ${x.valorPago > 0 ? 'badge-green' : 'badge-amber'}" style="margin-top:4px; display:inline-block;">${statusDespesa(x)}</span>
      <dl class="fin-card-grid">
        <div><dt>Empenhado</dt><dd>${fmtBRL(x.valorEmpenho)}</dd></div>
        <div><dt>Liquidado/Pago</dt><dd>${fmtBRL(x.valorPago)}</dd></div>
        <div><dt>Nota fiscal</dt><dd>${x.notaFiscal || '—'}</dd></div>
        <div><dt>Contrato</dt><dd>${x.contrato || '—'}</dd></div>
        <div><dt>Dotação</dt><dd>${x.dotacaoOrcamentaria || '—'}</dd></div>
        <div><dt>Elemento</dt><dd>${x.elementoDespesa || '—'}</dd></div>
        <div><dt>Unidade</dt><dd>${x.unidadeOrcamentariaNome || '—'}</dd></div>
        <div><dt>Licitação</dt><dd>${x.licitacaoModalidade || '—'}${x.processoLicitatorio ? ' (' + x.processoLicitatorio + ')' : ''}</dd></div>
      </dl>
      ${x.historico ? `<div class="fin-card-hist">${x.historico}</div>` : ''}
      ${metasTxt ? `<div class="screen-sub" style="margin-bottom:6px;">${metasTxt}</div>` : ''}
      ${x.observacoes ? `<div class="screen-sub" style="margin-bottom:6px;">${x.observacoes}</div>` : ''}
      <div class="fin-card-foot">
        <div style="display:flex; gap:10px; align-items:center;">
          ${linkDocumento(x)}
          <span class="badge ${x.validadoPorControleInterno ? 'badge-green' : 'badge-amber'}">${x.validadoPorControleInterno ? 'Validado' : 'Aguardando validação'}</span>
        </div>
        <div style="display:flex; gap:8px;">
          ${papelAtual() === 'controleInterno' && !x.validadoPorControleInterno ? `<button class="btn btn-sm" data-validar-despesa="${x.id}">Validar</button>` : ''}
          ${editavel ? `<button class="btn btn-sm" data-editar-despesa="${x.id}">Editar</button>` : ''}
          ${editavel ? `<button class="btn btn-sm btn-danger" data-rm-despesa="${x.id}">Excluir</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('') : '<div class="empty-state">Nenhuma despesa lançada ainda.</div>';
  document.querySelectorAll('[data-validar-despesa]').forEach(b => b.addEventListener('click', () => validarDespesa(b.dataset.validarDespesa)));
  document.querySelectorAll('[data-editar-despesa]').forEach(b => b.addEventListener('click', () => abrirDespesa(b.dataset.editarDespesa)));
  document.querySelectorAll('[data-rm-despesa]').forEach(b => b.addEventListener('click', () => excluirDespesa(b.dataset.rmDespesa)));
}
function renderReceitas() {
  const editavel = podeEditar();
  $('receitasLista').innerHTML = state.receitasAtual.length ? state.receitasAtual.map(x => `
    <div class="fin-card">
      <div class="fin-card-head">
        <div>
          <div class="fin-card-title">Receita</div>
          <div class="fin-card-sub">${x.origem || 'Origem não informada'}</div>
        </div>
        <div>
          <div class="fin-card-value">${fmtBRL(x.valor)}</div>
          <div class="fin-card-date">${x.data ? new Date(x.data + 'T00:00:00').toLocaleDateString('pt-BR') : ''}</div>
        </div>
      </div>
      ${x.contaBancaria ? `<dl class="fin-card-grid"><div><dt>Conta bancária</dt><dd>${x.contaBancaria}</dd></div></dl>` : ''}
      ${x.observacoes ? `<div class="screen-sub" style="margin-bottom:6px;">${x.observacoes}</div>` : ''}
      <div class="fin-card-foot">
        ${linkDocumento(x)}
        ${editavel ? `<div style="display:flex; gap:8px;"><button class="btn btn-sm" data-editar-receita="${x.id}">Editar</button><button class="btn btn-sm btn-danger" data-rm-receita="${x.id}">Excluir</button></div>` : ''}
      </div>
    </div>`).join('') : '<div class="empty-state">Nenhuma receita lançada ainda.</div>';
  document.querySelectorAll('[data-editar-receita]').forEach(b => b.addEventListener('click', () => abrirReceita(b.dataset.editarReceita)));
  document.querySelectorAll('[data-rm-receita]').forEach(b => b.addEventListener('click', () => excluirReceita(b.dataset.rmReceita)));
}
async function validarDespesa(id) {
  await updateDoc(doc(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId, 'despesas', id), {
    validadoPorControleInterno: true, validadoPor: state.perfil?.nome || state.user.email, validadoEm: serverTimestamp()
  });
  toast('Despesa validada.');
  await carregarDespesas(state.editandoEmendaId);
}
function excluirDespesa(id) {
  confirmar('Excluir despesa', 'Remove esse lançamento de empenho/liquidação/pagamento.', async () => {
    await deleteDoc(doc(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId, 'despesas', id));
    toast('Despesa excluída.');
    await carregarDespesas(state.editandoEmendaId);
    await recomputeResumoFinanceiro(state.editandoEmendaId);
  });
}
function excluirReceita(id) {
  confirmar('Excluir receita', 'Remove esse lançamento de receita.', async () => {
    await deleteDoc(doc(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId, 'receitas', id));
    toast('Receita excluída.');
    await carregarReceitas(state.editandoEmendaId);
    await recomputeResumoFinanceiro(state.editandoEmendaId);
  });
}

// ---- modal Nova Despesa ----
$('dpDotacao').addEventListener('blur', () => { $('dpDotacao').value = formatarDotacao($('dpDotacao').value); });
function abrirDespesa(id) {
  state.editandoDespesaId = id;
  const emenda = state.emendas.find(e => e.id === state.editandoEmendaId) || {};
  const metas = emenda.metas || [];
  const d = id ? state.despesasAtual.find(x => x.id === id) : null;
  $('modalDespesa').querySelector('.modal-title').textContent = id ? 'Editar despesa' : 'Nova despesa';
  $('dpEmpenho').value = d?.numeroEmpenho || ''; $('dpParcela').value = d?.parcela || '';
  $('dpCredorNome').value = d?.credorNome || ''; $('dpCredorCnpj').value = d?.credorCnpj || '';
  $('dpDotacao').value = d?.dotacaoOrcamentaria || ''; $('dpElemento').value = d?.elementoDespesa || '';
  $('dpUnidadeNome').value = d?.unidadeOrcamentariaNome || ''; $('dpUnidadeCodigo').value = d?.unidadeOrcamentariaCodigo || '';
  $('dpContaBancaria').value = d?.contaBancaria || ''; $('dpOrdemPagamento').value = d?.ordemPagamento || '';
  $('dpValorEmpenho').value = d?.valorEmpenho || ''; $('dpValorPago').value = d?.valorPago || '';
  $('dpDataPagamento').value = d?.dataPagamento || ''; $('dpHistorico').value = d?.historico || '';
  $('dpContrato').value = d?.contrato || ''; $('dpNotaFiscal').value = d?.notaFiscal || '';
  $('dpLicitacaoModalidade').value = d?.licitacaoModalidade || ''; $('dpProcessoLicitatorio').value = d?.processoLicitatorio || '';
  $('dpObs').value = d?.observacoes || '';
  $('dpArquivo').value = '';
  $('dpArquivoAtual').textContent = d?.documentoComprobatorioNome ? `Anexo atual: ${d.documentoComprobatorioNome} (escolha outro arquivo pra substituir)` :
    (d?.documentoDriveNome ? `Anexo atual (Drive): ${d.documentoDriveNome} (escolha outro arquivo pra substituir)` : '');
  $('dpArquivoHint').textContent = (state.enteDados.googleDrive && state.enteDados.googleDrive.clientId)
    ? 'Este ente tem Google Drive configurado — o arquivo vai direto pra lá (sem limite de 600KB). Vai pedir login do Google na hora de salvar.'
    : 'Anexado direto no cadastro — limite de ~600KB por arquivo (configure o Google Drive em Dados do Ente pra anexar arquivos maiores).';
  const metasVincExistentes = Object.fromEntries((d?.metasVinculadas || []).map(mv => [mv.metaId, mv.quantidade]));
  if (metas.length) {
    $('dpMetasWrap').style.display = '';
    $('dpMetasVinculacao').innerHTML = metas.map(m => `
      <div class="field" style="margin-bottom:8px;">
        <label style="font-weight:400;">${m.descricao || 'Meta'} (${m.unidade || ''})</label>
        <input type="number" step="0.01" data-meta-vinc="${m.id}" value="${metasVincExistentes[m.id] || ''}" placeholder="Quantidade entregue nesta despesa">
      </div>`).join('');
  } else {
    $('dpMetasWrap').style.display = 'none';
    $('dpMetasVinculacao').innerHTML = '';
  }
  $('modalDespesa').classList.add('active');
}
$('btnNovaDespesa').addEventListener('click', () => abrirDespesa(null));
// ---- Helper genérico de barra de progresso de upload (usado em vários formulários) ----
function progressoMostrar(prefixo, nomeArquivo) {
  $(prefixo + 'UploadProgress').classList.add('active');
  $(prefixo + 'UploadNome').textContent = nomeArquivo;
  $(prefixo + 'UploadPct').textContent = '0%';
  $(prefixo + 'UploadFill').style.width = '0%';
}
function progressoAtualizar(prefixo, pct) {
  $(prefixo + 'UploadPct').textContent = pct + '%';
  $(prefixo + 'UploadFill').style.width = pct + '%';
}
function progressoEsconder(prefixo) {
  $(prefixo + 'UploadProgress').classList.remove('active');
}

$('btnCancelarDespesa').addEventListener('click', () => $('modalDespesa').classList.remove('active'));
$('btnSalvarDespesa').addEventListener('click', async () => {
  const numeroEmpenho = $('dpEmpenho').value.trim(), credorNome = $('dpCredorNome').value.trim();
  const valorEmpenho = Number($('dpValorEmpenho').value) || 0;
  if (!numeroEmpenho || !credorNome || !valorEmpenho) { toast('Preencha nº do empenho, credor e valor do empenho.', true); return; }
  const btn = $('btnSalvarDespesa'); btn.disabled = true;
  try {
    const arquivo = $('dpArquivo').files[0];
    let anexo = null; // null = manter anexo já existente (edição)
    if (arquivo) {
      progressoMostrar('dp', arquivo.name);
      try {
        anexo = await processarAnexo(arquivo, (pct) => progressoAtualizar('dp', pct));
      } finally { progressoEsconder('dp'); }
    }
    const metasVinculadas = [];
    document.querySelectorAll('[data-meta-vinc]').forEach(el => {
      const q = Number(el.value) || 0;
      if (q > 0) metasVinculadas.push({ metaId: el.dataset.metaVinc, quantidade: q });
    });
    const emenda = state.emendas.find(e => e.id === state.editandoEmendaId);
    const parcela = $('dpParcela').value.trim();
    const notaFiscal = $('dpNotaFiscal').value.trim();
    const payload = {
      numeroEmpenho, parcela, credorNome, credorCnpj: $('dpCredorCnpj').value.trim(),
      dotacaoOrcamentaria: formatarDotacao($('dpDotacao').value), elementoDespesa: $('dpElemento').value.trim(),
      unidadeOrcamentariaNome: $('dpUnidadeNome').value.trim(), unidadeOrcamentariaCodigo: $('dpUnidadeCodigo').value.trim(),
      contaBancaria: $('dpContaBancaria').value.trim(), ordemPagamento: $('dpOrdemPagamento').value.trim(),
      valorEmpenho, valorPago: Number($('dpValorPago').value) || 0, dataPagamento: $('dpDataPagamento').value,
      historico: $('dpHistorico').value.trim(), contrato: $('dpContrato').value.trim(),
      notaFiscal, licitacaoModalidade: $('dpLicitacaoModalidade').value.trim(),
      processoLicitatorio: $('dpProcessoLicitatorio').value.trim(),
      ano: emenda?.exercicio || new Date().getFullYear(), metasVinculadas,
      chaveImportacao: chaveDespesa({ numeroEmpenho, parcela, notaFiscal }),
      observacoes: $('dpObs').value.trim(),
    };
    // Só mexe nos campos de anexo se um arquivo novo foi escolhido — assim,
    // editar uma despesa sem trocar o arquivo mantém o anexo já salvo.
    if (anexo) Object.assign(payload, anexo);
    if (state.editandoDespesaId) {
      await updateDoc(doc(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId, 'despesas', state.editandoDespesaId), payload);
      toast('Despesa atualizada!');
    } else {
      if (!anexo) Object.assign(payload, { documentoComprobatorioArquivo: null, documentoComprobatorioNome: null, documentoComprobatorioTipo: null, documentoDriveLink: null, documentoDriveNome: null });
      await addDoc(collection(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId, 'despesas'), {
        ...payload, validadoPorControleInterno: false, criadoEm: serverTimestamp(), criadoPor: state.user.uid
      });
      toast('Despesa lançada!');
    }
    $('modalDespesa').classList.remove('active');
    await carregarDespesas(state.editandoEmendaId);
    await recomputeResumoFinanceiro(state.editandoEmendaId);
  } catch (err) {
    toast(err.message, true);
  } finally { btn.disabled = false; }
});
function chaveDespesa({ numeroEmpenho, parcela, notaFiscal }) {
  return `${(numeroEmpenho || '').trim()}|${(parcela || '').trim()}|${(notaFiscal || '').trim()}`.toLowerCase();
}
// Reagrupa a dotação orçamentária no padrão oficial 99.999.9999.9999.9999
// (órgão.função.subfunção.programa.ação — 2+3+4+4+4 = 17 dígitos). Muitos
// sistemas de origem exportam os mesmos dígitos com pontuação diferente
// (ex: "15.451.000.712.500.000"); aqui a gente ignora a pontuação de
// origem e reagrupa do zero a partir só dos dígitos.
function formatarDotacao(v) {
  const digitos = String(v || '').replace(/\D/g, '');
  if (digitos.length !== 17) return (v || '').trim(); // formato fora do padrão esperado — mantém como veio
  return `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5, 9)}.${digitos.slice(9, 13)}.${digitos.slice(13, 17)}`;
}
// Lê um arquivo pequeno (comprovante) como base64 direto no navegador — sem
// Storage pago, mesma lógica usada pra logos no app da igreja. Limite baixo
// porque o documento inteiro da despesa tem teto de 1MB no Firestore.
// onProgress(pct) é opcional e recebe 0-100 conforme a leitura avança.
function lerArquivoComoBase64(file, onProgress) {
  return new Promise((resolve, reject) => {
    if (file.size > 600 * 1024) { reject(new Error('Arquivo maior que 600KB — reduza o tamanho (ex: comprima o PDF/foto), ou configure o Google Drive em Dados do Ente pra anexar arquivos maiores.')); return; }
    const reader = new FileReader();
    if (onProgress) {
      reader.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    }
    reader.onload = () => { if (onProgress) onProgress(100); resolve(reader.result); };
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

// ---- modal Nova Receita ----
function abrirReceita(id) {
  state.editandoReceitaId = id;
  const r = id ? state.receitasAtual.find(x => x.id === id) : null;
  $('modalReceita').querySelector('.modal-title').textContent = id ? 'Editar receita' : 'Nova receita';
  $('rcData').value = r?.data || ''; $('rcValor').value = r?.valor || '';
  $('rcContaBancaria').value = r?.contaBancaria || ''; $('rcOrigem').value = r?.origem || '';
  $('rcObs').value = r?.observacoes || ''; $('rcArquivo').value = '';
  $('rcArquivoHint').textContent = (state.enteDados.googleDrive && state.enteDados.googleDrive.clientId)
    ? 'Este ente tem Google Drive configurado — o arquivo vai direto pra lá (sem limite de 600KB).'
    : 'Anexado direto no cadastro — limite de ~600KB por arquivo.';
  if (r?.documentoComprobatorioNome) $('rcArquivoHint').textContent += ` Anexo atual: ${r.documentoComprobatorioNome} (escolha outro pra substituir).`;
  else if (r?.documentoDriveNome) $('rcArquivoHint').textContent += ` Anexo atual (Drive): ${r.documentoDriveNome} (escolha outro pra substituir).`;
  $('modalReceita').classList.add('active');
}
$('btnNovaReceita').addEventListener('click', () => abrirReceita(null));
$('btnCancelarReceita').addEventListener('click', () => $('modalReceita').classList.remove('active'));
$('btnSalvarReceita').addEventListener('click', async () => {
  const data = $('rcData').value, valor = Number($('rcValor').value);
  if (!data || !valor) { toast('Preencha data e valor.', true); return; }
  const btn = $('btnSalvarReceita'); btn.disabled = true;
  try {
    const arquivo = $('rcArquivo').files[0];
    let anexo = null;
    if (arquivo) {
      progressoMostrar('rc', arquivo.name);
      try {
        anexo = await processarAnexo(arquivo, (pct) => progressoAtualizar('rc', pct));
      } finally { progressoEsconder('rc'); }
    }
    const emenda = state.emendas.find(e => e.id === state.editandoEmendaId);
    const payload = {
      data, valor, contaBancaria: $('rcContaBancaria').value.trim(), origem: $('rcOrigem').value.trim(),
      ano: emenda?.exercicio || new Date().getFullYear(), observacoes: $('rcObs').value.trim(),
    };
    if (anexo) Object.assign(payload, anexo);
    if (state.editandoReceitaId) {
      await updateDoc(doc(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId, 'receitas', state.editandoReceitaId), payload);
      toast('Receita atualizada!');
    } else {
      if (!anexo) Object.assign(payload, { documentoComprobatorioArquivo: null, documentoComprobatorioNome: null, documentoComprobatorioTipo: null, documentoDriveLink: null, documentoDriveNome: null });
      await addDoc(collection(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId, 'receitas'), {
        ...payload, criadoEm: serverTimestamp(), criadoPor: state.user.uid
      });
      toast('Receita lançada!');
    }
    $('modalReceita').classList.remove('active');
    await carregarReceitas(state.editandoEmendaId);
    await recomputeResumoFinanceiro(state.editandoEmendaId);
  } catch (err) {
    toast(err.message, true);
  } finally { btn.disabled = false; }
});

// Denormaliza os totais de despesas/receitas no próprio documento da
// emenda — assim o Painel, a Conformidade e o Acompanhamento Consolidado
// não precisam reler todas as subcoleções de cada emenda pra montar a tela.
async function recomputeResumoFinanceiro(emendaId) {
  const [despSnap, recSnap] = await Promise.all([
    getDocs(collection(db, 'entes', state.enteAtualId, 'emendas', emendaId, 'despesas')),
    getDocs(collection(db, 'entes', state.enteAtualId, 'emendas', emendaId, 'receitas')),
  ]);
  const despesas = despSnap.docs.map(d => d.data());
  const receitas = recSnap.docs.map(d => d.data());
  const emenda = state.emendas.find(e => e.id === emendaId) || {};
  const metasDefinidas = emenda.metas || [];

  const totalEmpenhado = despesas.reduce((s, x) => s + (x.valorEmpenho || 0), 0);
  const totalPago = despesas.reduce((s, x) => s + (x.valorPago || 0), 0);
  const totalReceita = receitas.reduce((s, x) => s + (x.valor || 0), 0);

  let percFisicoAtual = 0, metasResumo = [];
  if (metasDefinidas.length) {
    // Execução física = média do % de atendimento de cada meta, somando a
    // quantidade entregue por TODAS as despesas vinculadas àquela meta.
    metasResumo = metasDefinidas.map(m => {
      const quantidadeRealizada = despesas.reduce((s, x) => {
        const v = (x.metasVinculadas || []).find(mv => mv.metaId === m.id);
        return s + (v ? v.quantidade : 0);
      }, 0);
      const percentual = m.quantidadePrevista > 0 ? Math.min(100, Math.round((quantidadeRealizada / m.quantidadePrevista) * 1000) / 10) : 0;
      return { id: m.id, descricao: m.descricao, unidade: m.unidade, quantidadePrevista: m.quantidadePrevista, quantidadeRealizada, percentual };
    });
    percFisicoAtual = Math.round((metasResumo.reduce((s, m) => s + m.percentual, 0) / metasResumo.length) * 10) / 10;
  }
  // % financeiro agora também é automático: valor pago sobre o valor total da emenda.
  const percFinanceiroAtual = emenda.valorTotal > 0 ? Math.min(100, Math.round((totalPago / emenda.valorTotal) * 1000) / 10) : 0;

  const resumo = {
    totalEmpenhado, totalLiquidado: totalPago, totalPago, totalReceita,
    percFisicoAtual, percFinanceiroAtual, metas: metasResumo,
    qtdDespesas: despesas.length, qtdReceitas: receitas.length,
    qtdComDocumento: despesas.filter(x => !!x.documentoComprobatorioArquivo || !!x.documentoDriveLink).length,
    atualizadoEm: serverTimestamp()
  };
  await updateDoc(doc(db, 'entes', state.enteAtualId, 'emendas', emendaId), { resumoExecucao: resumo });
  const idx = state.emendas.findIndex(e => e.id === emendaId);
  if (idx >= 0) state.emendas[idx].resumoExecucao = resumo;
  if (state.emendaEmEdicao && state.editandoEmendaId === emendaId) { state.emendaEmEdicao.resumoExecucao = resumo; renderChecklistEmenda(); }
}

// ---- Importação de despesas por planilha (empenho/liquidação/pagamento) ----
// Aceita o mesmo formato exportado pelos sistemas contábeis municipais
// (colunas em maiúsculas: EMPENHO, NOME, CFPRO, CATEC, UNIDADENOME,
// UNIDADE, CONTAC, VAPAG, ORDPG, DTLAN, HISTORICO, CONTRATO, LICMOD,
// PROCLIC, NOTAFISCAL, VALOREMPENHO, CNPJFORNECEDOR, PARCELA).
const COLUNAS_IMPORT_DESPESA = ['EMPENHO', 'NOME', 'CFPRO', 'CATEC', 'UNIDADENOME', 'UNIDADE', 'CONTAC', 'VAPAG', 'ORDPG', 'DTLAN', 'HISTORICO', 'CONTRATO', 'LICMOD', 'PROCLIC', 'NOTAFISCAL', 'VALOREMPENHO', 'CNPJFORNECEDOR', 'PARCELA'];
function parseValorBR(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim();
  if (s.includes(',')) return Number(s.replace(/\./g, '').replace(',', '.')) || 0;
  return Number(s) || 0;
}
function parseDataBR(v) {
  if (!v) return '';
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return '';
}
async function lerPlanilhaGenerica(file) {
  if (file.name.toLowerCase().endsWith('.csv')) {
    const texto = await file.text();
    const linhas = texto.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
    if (!linhas.length) return [];
    const headers = linhas[0].replace(/^\uFEFF/, '').split(';').map(h => h.trim().toUpperCase());
    return linhas.slice(1).map(linha => {
      const cols = linha.split(';');
      const obj = {};
      headers.forEach((h, i) => obj[h] = (cols[i] || '').trim());
      return obj;
    });
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return linhas.map(obj => {
    const norm = {};
    Object.entries(obj).forEach(([k, v]) => norm[String(k).trim().toUpperCase()] = v);
    return norm;
  });
}
$('btnModeloDespesas').addEventListener('click', () => {
  const exemplo = { EMPENHO: '427001', NOME: 'PONTES EMPREENDIMENTOS LTDA', CFPRO: '15.451.000.712.500.000', CATEC: '4.4.90.51.01', UNIDADENOME: 'SEC MUN INFRAESTRUTURA', UNIDADE: '20900', CONTAC: '59.702-3', VAPAG: '7854,04', ORDPG: '430037', DTLAN: '30/04/2025', HISTORICO: 'Descrição do objeto da despesa', CONTRATO: '0061/24', LICMOD: 'CONCORRÊNCIA ELETRÔNICA 0001/24', PROCLIC: '000050/24', NOTAFISCAL: '000000000050-NFSe', VALOREMPENHO: '16458,69', CNPJFORNECEDOR: '40.141.083/0001-53', PARCELA: '427001-1' };
  const ws = XLSX.utils.json_to_sheet([exemplo], { header: COLUNAS_IMPORT_DESPESA });
  const wsInstrucoes = XLSX.utils.aoa_to_sheet([
    ['Instruções para importação de despesas'],
    [''],
    ['Preencha uma linha por despesa (empenho + liquidação + pagamento juntos).'],
    ['Datas no formato DD/MM/AAAA. Valores decimais com vírgula (ex: 1234,56).'],
    ['PARCELA precisa ser único por lançamento — é usado para não importar a mesma despesa duas vezes.'],
    ['EMPENHO = número do empenho'], ['NOME = nome do credor/fornecedor'],
    ['CFPRO = dotação orçamentária (99.999.9999.9999.9999)'], ['CATEC = elemento de despesa (9.9.99.99.99)'],
    ['UNIDADENOME = nome da unidade orçamentária'], ['UNIDADE = código da unidade orçamentária'],
    ['CONTAC = conta bancária'], ['VAPAG = valor da liquidação/pagamento'], ['ORDPG = ordem de pagamento'],
    ['DTLAN = data do pagamento'], ['HISTORICO = objeto da despesa'], ['CONTRATO = contrato vinculado'],
    ['LICMOD = modalidade de licitação'], ['PROCLIC = processo licitatório'], ['NOTAFISCAL = número da nota fiscal'],
    ['VALOREMPENHO = valor do empenho'], ['CNPJFORNECEDOR = CNPJ do credor/fornecedor'],
    ['PARCELA = identificador único da parcela/liquidação'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsInstrucoes, 'Instruções');
  XLSX.utils.book_append_sheet(wb, ws, 'Despesas');
  XLSX.writeFile(wb, 'modelo_importacao_despesas.xlsx');
});
$('btnImportarDespesas').addEventListener('click', () => $('dpImportarArquivo').click());
$('dpImportarArquivo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const log = $('importDespesasLog');
  log.style.display = 'block'; log.textContent = 'Lendo planilha...\n';
  try {
    const linhas = await lerPlanilhaGenerica(file);
    if (!linhas.length) { log.textContent += 'Planilha vazia.'; return; }
    const faltando = COLUNAS_IMPORT_DESPESA.filter(c => !(c in linhas[0]));
    if (faltando.length) { log.textContent += `Colunas faltando na planilha: ${faltando.join(', ')}`; return; }

    const emenda = state.emendas.find(e => e.id === state.editandoEmendaId);
    const chavesExistentes = new Set(state.despesasAtual.map(x => x.chaveImportacao).filter(Boolean));
    let criadas = 0, duplicadas = 0, comErro = 0;
    for (const linha of linhas) {
      const numeroEmpenho = String(linha.EMPENHO || '').trim();
      const parcela = String(linha.PARCELA || '').trim();
      const notaFiscal = String(linha.NOTAFISCAL || '').trim();
      if (!numeroEmpenho) { comErro++; continue; }
      const chave = chaveDespesa({ numeroEmpenho, parcela, notaFiscal });
      if (chavesExistentes.has(chave)) { duplicadas++; continue; }
      try {
        await addDoc(collection(db, 'entes', state.enteAtualId, 'emendas', state.editandoEmendaId, 'despesas'), {
          numeroEmpenho, parcela, credorNome: String(linha.NOME || '').trim(), credorCnpj: String(linha.CNPJFORNECEDOR || '').trim(),
          dotacaoOrcamentaria: formatarDotacao(linha.CFPRO), elementoDespesa: String(linha.CATEC || '').trim(),
          unidadeOrcamentariaNome: String(linha.UNIDADENOME || '').trim(), unidadeOrcamentariaCodigo: String(linha.UNIDADE || '').trim(),
          contaBancaria: String(linha.CONTAC || '').trim(), ordemPagamento: String(linha.ORDPG || '').trim(),
          valorEmpenho: parseValorBR(linha.VALOREMPENHO), valorPago: parseValorBR(linha.VAPAG),
          dataPagamento: parseDataBR(linha.DTLAN), historico: String(linha.HISTORICO || '').trim(),
          contrato: String(linha.CONTRATO || '').trim(), notaFiscal, licitacaoModalidade: String(linha.LICMOD || '').trim(),
          processoLicitatorio: String(linha.PROCLIC || '').trim(), ano: emenda?.exercicio || new Date().getFullYear(),
          metasVinculadas: [], chaveImportacao: chave, origemImportacao: true,
          documentoComprobatorioArquivo: null, documentoComprobatorioNome: null, documentoComprobatorioTipo: null,
          observacoes: '', validadoPorControleInterno: false, criadoEm: serverTimestamp(), criadoPor: state.user.uid
        });
        chavesExistentes.add(chave);
        criadas++;
      } catch (err) { comErro++; }
    }
    log.textContent += `Concluído: ${criadas} despesa(s) importada(s), ${duplicadas} já existiam (ignoradas), ${comErro} com erro/sem empenho.\nAs metas físicas não vêm da planilha — vincule manualmente em cada despesa, se precisar.`;
    toast(`Importação concluída: ${criadas} despesa(s) nova(s).`);
    await carregarDespesas(state.editandoEmendaId);
    await recomputeResumoFinanceiro(state.editandoEmendaId);
  } catch (err) {
    log.textContent += 'Erro: ' + err.message;
  } finally {
    $('dpImportarArquivo').value = '';
  }
});

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
    acc.liquidado += r.totalLiquidado || 0; acc.pago += r.totalPago || 0; acc.receita += r.totalReceita || 0;
    return acc;
  }, { previsto: 0, empenhado: 0, liquidado: 0, pago: 0, receita: 0 });

  $('acompCards').innerHTML = `
    <div class="card"><div class="kpi-label">Valor previsto</div><div class="kpi-value" style="font-size:17px;">${fmtBRL(totais.previsto)}</div></div>
    <div class="card"><div class="kpi-label">Recebido (receita)</div><div class="kpi-value" style="font-size:17px;">${fmtBRL(totais.receita)}</div></div>
    <div class="card"><div class="kpi-label">Empenhado</div><div class="kpi-value" style="font-size:17px;">${fmtBRL(totais.empenhado)}</div></div>
    <div class="card"><div class="kpi-label">Liquidado/Pago</div><div class="kpi-value" style="font-size:17px;">${fmtBRL(totais.pago)}</div><div class="kpi-sub">${totais.previsto > 0 ? Math.round(totais.pago / totais.previsto * 1000) / 10 : 0}% do previsto</div></div>`;

  $('acompTbody').innerHTML = lista.map(e => {
    const r = e.resumoExecucao || {};
    const metasResumo = r.metas || [];
    const metaTexto = metasResumo.length ? `${metasResumo.filter(m => m.percentual >= 100).length}/${metasResumo.length} metas 100%` : '—';
    return `<tr>
      <td>${e.numeroEmenda || '—'} — ${(e.objeto || '').slice(0, 40)}</td>
      <td class="num">${fmtBRL(e.valorTotal)}</td>
      <td class="num">${fmtBRL(r.totalEmpenhado)}</td>
      <td class="num">${fmtBRL(r.totalLiquidado)}</td>
      <td class="num">${fmtBRL(r.totalPago)}</td>
      <td class="num">${r.percFisicoAtual || 0}%</td>
      <td class="num">${r.percFinanceiroAtual || 0}%</td>
      <td class="num">${metaTexto}</td>
      <td class="num">${r.qtdComDocumento || 0}/${r.qtdDespesas || 0}</td>
    </tr>`;
  }).join('');
  $('acompEmpty').style.display = lista.some(e => (e.resumoExecucao?.qtdDespesas || 0) > 0) ? 'none' : 'block';
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
  const drive = d.googleDrive || {};
  $('deDriveClientId').value = drive.clientId || ''; $('deDriveFolderId').value = drive.folderId || '';
  const editavel = papelAtual() === 'admin';
  ['deNome', 'deEsfera', 'deMunicipio', 'deUf', 'deNomeRelatorio', 'deResponsavel', 'deControleInterno'].forEach(id => $(id).disabled = !editavel);
  $('deLogoFile').disabled = !editavel;
  $('deDriveClientId').disabled = !editavel; $('deDriveFolderId').disabled = !editavel;
  $('btnSalvarDadosEnte').style.display = editavel ? '' : 'none';
  $('btnRemoverLogoEnte').style.display = editavel ? '' : 'none';
  $('btnSalvarDrive').style.display = editavel ? '' : 'none';
}
$('btnSalvarDrive').addEventListener('click', async () => {
  const googleDrive = { clientId: $('deDriveClientId').value.trim(), folderId: $('deDriveFolderId').value.trim() };
  await updateDoc(doc(db, 'entes', state.enteAtualId), { googleDrive });
  state.enteDados = { ...state.enteDados, googleDrive };
  toast('Configuração do Google Drive salva!');
});
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
// ============================================================
// GOOGLE DRIVE (anexo opcional de arquivos maiores, configurável por ente)
// ============================================================
// Usa o Google Identity Services (carregado sob demanda) pra pedir um
// token OAuth com escopo "drive.file" — esse escopo só dá acesso aos
// arquivos que o próprio app cria, nunca ao Drive inteiro da pessoa.
// Não precisa de servidor: o upload vai direto do navegador pra API do
// Google, usando a conta de quem estiver autorizando no momento.
let googleTokenClient = null;
let googleAccessToken = null;
function carregarGis() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Não foi possível carregar o Google Identity Services (verifique sua conexão).'));
    document.head.appendChild(s);
  });
}
async function obterTokenGoogleDrive(clientId) {
  await carregarGis();
  return new Promise((resolve, reject) => {
    try {
      googleTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: (resp) => {
          if (resp.error) { reject(new Error('Autorização do Google negada ou cancelada.')); return; }
          googleAccessToken = resp.access_token;
          resolve(resp.access_token);
        }
      });
      googleTokenClient.requestAccessToken({ prompt: googleAccessToken ? '' : 'consent' });
    } catch (e) { reject(new Error('Client ID do Google inválido ou domínio não autorizado.')); }
  });
}
async function enviarParaGoogleDrive(file, clientId, folderId, onProgress) {
  const token = await obterTokenGoogleDrive(clientId);
  const metadata = { name: file.name };
  if (folderId) metadata.parents = [folderId];
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', file);
  // Usamos XMLHttpRequest (não fetch) porque só ele expõe progresso real de
  // ENVIO (upload.onprogress) — o fetch só reporta progresso de download.
  const data = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,name');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(JSON.parse(xhr.responseText)); }
      else { reject(new Error('Falha ao enviar o arquivo para o Google Drive (verifique a pasta e as permissões).')); }
    };
    xhr.onerror = () => reject(new Error('Falha de conexão ao enviar para o Google Drive.'));
    xhr.send(form);
  });
  // Torna o arquivo legível por link — necessário pra aparecer no Portal
  // Público sem exigir login de quem está consultando.
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    });
  } catch (e) { /* segue mesmo se não conseguir tornar público — link ainda funciona pra quem tem acesso à pasta */ }
  return { link: data.webViewLink, nome: data.name };
}
// Escolhe automaticamente Drive (se o ente configurou) ou base64 (padrão).
// Devolve sempre o mesmo formato de campos pra gravar no documento.
// onProgress(pct) é opcional — recebe 0-100 conforme o envio/leitura avança.
async function processarAnexo(file, onProgress) {
  if (!file) return { documentoComprobatorioArquivo: null, documentoComprobatorioNome: null, documentoComprobatorioTipo: null, documentoDriveLink: null, documentoDriveNome: null };
  const drive = state.enteDados.googleDrive;
  if (drive && drive.clientId) {
    const { link, nome } = await enviarParaGoogleDrive(file, drive.clientId, drive.folderId, onProgress);
    return { documentoComprobatorioArquivo: null, documentoComprobatorioNome: null, documentoComprobatorioTipo: null, documentoDriveLink: link, documentoDriveNome: nome };
  }
  const base64 = await lerArquivoComoBase64(file, onProgress);
  return { documentoComprobatorioArquivo: base64, documentoComprobatorioNome: file.name, documentoComprobatorioTipo: file.type, documentoDriveLink: null, documentoDriveNome: null };
}

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
    const r = e.resumoExecucao || {}; const metas = e.metas || [];
    return {
      'Nº': e.numeroEmenda, 'Esfera': ESFERA_LABEL[e.esfera] || e.esfera, 'Exercício': e.exercicio,
      'Autor': e.autorEmenda, 'Partido/Unidade': e.partidoUnidade, 'Objeto': e.objeto, 'Valor Total': e.valorTotal,
      'Ato Normativo': e.atoNormativoOrcamentario, 'Órgão Executor': e.orgaoEntidadeExecutora,
      'Localidade Beneficiada': e.localidadeBeneficiada, 'Beneficiário Final': e.beneficiarioFinal,
      'Metas Físicas': metas.map(m => `${m.descricao} (${m.quantidadePrevista} ${m.unidade || ''})`).join('; '),
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
const portalChartInstances = new Map(); // uma instância de gráfico por emenda (destruídas a cada re-render)
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

  const ESFERA_COR = { federal: 'badge-brand', estadual: 'badge-amber', municipal: 'badge-green' };

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

    // ---- Lista de emendas ----
    const metasHtml = (e) => {
      const resumoMetas = (r(e).metas && r(e).metas.length) ? r(e).metas : (e.metas || []).map(m => ({ ...m, quantidadeRealizada: 0, percentual: 0 }));
      if (!resumoMetas.length) return '';
      return `<div class="publico-metas"><div class="publico-bar-label"><strong>Metas físicas</strong></div>` +
        resumoMetas.map(m => `
          <div style="margin-bottom:8px;">
            <div class="publico-bar-label"><span>${m.descricao || 'Meta'}</span><span>${m.quantidadeRealizada || 0} de ${m.quantidadePrevista} ${m.unidade || ''} — ${m.percentual || 0}%</span></div>
            <div class="conf-bar-track"><div class="conf-bar-fill" style="width:${Math.min(100, m.percentual || 0)}%; background:var(--cyan);"></div></div>
          </div>`).join('') + `</div>`;
    };
    const anexosHtml = (e) => {
      const lista = e.anexos || [];
      if (!lista.length) return '';
      return `<div class="publico-metas"><div class="publico-bar-label"><strong>Documentos da emenda</strong></div>` +
        lista.map(a => a.arquivo
          ? `<div style="margin-bottom:4px;"><a class="fin-doc-link" href="${a.arquivo}" download="${a.nome}">📎 ${a.nome}</a></div>`
          : (a.driveLink ? `<div style="margin-bottom:4px;"><a class="fin-doc-link" href="${a.driveLink}" target="_blank" rel="noopener">📎 ${a.driveNome || a.nome}</a></div>` : '')
        ).join('') + `</div>`;
    };
    $('portalLista').innerHTML = lista.length ? lista.map(e => {
      const pFisico = Math.min(100, r(e).percFisicoAtual || 0), pFinanceiro = Math.min(100, r(e).percFinanceiroAtual || 0);
      return `
      <div class="publico-emenda">
        <div class="publico-emenda-head">
          <div>
            <span class="badge ${ESFERA_COR[e.esfera] || 'badge-brand'}">${ESFERA_LABEL[e.esfera] || e.esfera}</span>
            <span class="screen-sub" style="margin-left:6px;">Nº ${e.numeroEmenda || '—'} · ${e.exercicio || '—'}</span>
            <h3 style="margin-top:6px;">${e.objeto || 'Sem objeto informado'}</h3>
          </div>
          <div class="publico-valor">${fmtBRL(e.valorTotal)}</div>
        </div>

        <div class="publico-bars">
          <div>
            <div class="publico-bar-label"><span>Execução física</span><span>${pFisico}%</span></div>
            <div class="conf-bar-track"><div class="conf-bar-fill" style="width:${pFisico}%; background:${pFisico === 100 ? 'var(--green)' : 'var(--cyan)'};"></div></div>
          </div>
          <div>
            <div class="publico-bar-label"><span>Execução financeira</span><span>${pFinanceiro}%</span></div>
            <div class="conf-bar-track"><div class="conf-bar-fill" style="width:${pFinanceiro}%; background:${pFinanceiro === 100 ? 'var(--green)' : 'var(--amber)'};"></div></div>
          </div>
        </div>

        <div class="publico-chart-wrap">
          <div class="publico-bar-label"><strong>Execução financeira desta emenda</strong></div>
          <canvas id="portalChartEmenda-${e.id}" height="140"></canvas>
        </div>

        <dl class="publico-grid">
          <div><dt>Autor / Parlamentar</dt><dd>${e.autorEmenda || '—'}</dd></div>
          <div><dt>Partido/Unidade</dt><dd>${e.partidoUnidade || '—'}</dd></div>
          <div><dt>Ato normativo</dt><dd>${e.atoNormativoOrcamentario || '—'}</dd></div>
          <div><dt>Órgão executor</dt><dd>${e.orgaoEntidadeExecutora || '—'}</dd></div>
          <div><dt>Localidade beneficiada</dt><dd>${e.localidadeBeneficiada || '—'}</dd></div>
          <div><dt>Beneficiário final</dt><dd>${e.beneficiarioFinal || '—'}</dd></div>
          <div><dt>Recebido</dt><dd>${fmtBRL(r(e).totalReceita)}</dd></div>
          <div><dt>Empenhado</dt><dd>${fmtBRL(r(e).totalEmpenhado)}</dd></div>
          <div><dt>Liquidado</dt><dd>${fmtBRL(r(e).totalLiquidado)}</dd></div>
          <div><dt>Pago</dt><dd>${fmtBRL(r(e).totalPago)}</dd></div>
        </dl>
        ${metasHtml(e)}
        ${anexosHtml(e)}
        <button class="btn btn-sm" style="margin-top:14px;" data-ver-exec="${e.id}">Ver despesas, receitas e documentos</button>
        <div id="portalExec-${e.id}" style="margin-top:10px;"></div>
      </div>`;
    }).join('') : '<div class="empty-state">Nenhuma emenda pública encontrada para este filtro.</div>';

    // ---- Gráfico de execução financeira, um por emenda (destrói os antigos antes) ----
    portalChartInstances.forEach(c => c.destroy());
    portalChartInstances.clear();
    if (window.Chart) {
      lista.forEach(e => {
        const ctx = document.getElementById(`portalChartEmenda-${e.id}`);
        if (!ctx) return;
        const chart = new Chart(ctx, {
          type: 'bar',
          data: {
            labels: ['Previsto', 'Recebido', 'Empenhado', 'Pago'],
            datasets: [{
              data: [e.valorTotal || 0, r(e).totalReceita || 0, r(e).totalEmpenhado || 0, r(e).totalPago || 0],
              backgroundColor: ['#93a8bc', '#14b8ee', '#b3790f', '#16875a'],
              borderRadius: 5, maxBarThickness: 46
            }]
          },
          options: {
            indexAxis: 'y',
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtBRL(c.parsed.x) } } },
            scales: { x: { ticks: { callback: (v) => fmtBRL(v) } } }
          }
        });
        portalChartInstances.set(e.id, chart);
      });
    }

    document.querySelectorAll('[data-ver-exec]').forEach(btn => btn.addEventListener('click', async () => {
      const alvo = $('portalExec-' + btn.dataset.verExec);
      if (alvo.dataset.carregado) { alvo.style.display = alvo.style.display === 'none' ? '' : 'none'; return; }
      const [despSnap, recSnap] = await Promise.all([
        getDocs(query(collection(db, 'entes', enteId, 'emendas', btn.dataset.verExec, 'despesas'), orderBy('dataPagamento', 'desc'))),
        getDocs(query(collection(db, 'entes', enteId, 'emendas', btn.dataset.verExec, 'receitas'), orderBy('data', 'desc'))),
      ]);
      const despesas = despSnap.docs.map(d => d.data());
      const receitas = recSnap.docs.map(d => d.data());
      const despesasHtml = despesas.length ? `<h4 class="fin-card-sub" style="text-transform:uppercase; letter-spacing:.04em; margin:14px 0 8px;">Despesas</h4>` + despesas.map(x => `
        <div class="fin-card">
          <div class="fin-card-head">
            <div>
              <div class="fin-card-title">Empenho ${x.numeroEmpenho || '—'} — ${x.credorNome || '—'}</div>
              <div class="fin-card-sub">${x.credorCnpj || ''}</div>
            </div>
            <div>
              <div class="fin-card-value">${fmtBRL(x.valorPago || x.valorEmpenho)}</div>
              <div class="fin-card-date">${x.dataPagamento ? new Date(x.dataPagamento + 'T00:00:00').toLocaleDateString('pt-BR') : ''}</div>
            </div>
          </div>
          <dl class="fin-card-grid">
            <div><dt>Empenhado</dt><dd>${fmtBRL(x.valorEmpenho)}</dd></div>
            <div><dt>Liquidado/Pago</dt><dd>${fmtBRL(x.valorPago)}</dd></div>
            <div><dt>Nota fiscal</dt><dd>${x.notaFiscal || '—'}</dd></div>
            <div><dt>Contrato</dt><dd>${x.contrato || '—'}</dd></div>
            <div><dt>Dotação</dt><dd>${x.dotacaoOrcamentaria || '—'}</dd></div>
            <div><dt>Elemento</dt><dd>${x.elementoDespesa || '—'}</dd></div>
            <div><dt>Unidade</dt><dd>${x.unidadeOrcamentariaNome || '—'}</dd></div>
            <div><dt>Licitação</dt><dd>${x.licitacaoModalidade || '—'}${x.processoLicitatorio ? ' (' + x.processoLicitatorio + ')' : ''}</dd></div>
          </dl>
          ${x.historico ? `<div class="fin-card-hist">${x.historico}</div>` : ''}
          <div class="fin-card-foot">${linkDocumento(x)}</div>
        </div>`).join('') : '<div class="empty-state">Nenhuma despesa lançada ainda.</div>';
      const receitasHtml = receitas.length ? `<h4 class="fin-card-sub" style="text-transform:uppercase; letter-spacing:.04em; margin:14px 0 8px;">Receitas</h4>` + receitas.map(x => `
        <div class="fin-card">
          <div class="fin-card-head">
            <div>
              <div class="fin-card-title">Receita</div>
              <div class="fin-card-sub">${x.origem || 'Origem não informada'}</div>
            </div>
            <div>
              <div class="fin-card-value">${fmtBRL(x.valor)}</div>
              <div class="fin-card-date">${x.data ? new Date(x.data + 'T00:00:00').toLocaleDateString('pt-BR') : ''}</div>
            </div>
          </div>
          <div class="fin-card-foot">${linkDocumento(x)}</div>
        </div>`).join('') : '';
      alvo.innerHTML = despesasHtml + receitasHtml;
      alvo.dataset.carregado = '1';
    }));
  }
  $('portalFiltroExercicio').addEventListener('change', render);
  $('portalFiltroEsfera').addEventListener('change', render);
  $('portalBusca').addEventListener('input', render);
  render();
}
