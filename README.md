# SOFT+ Emendas Parlamentares

App multi-ente de controle de emendas parlamentares (federais, estaduais e
municipais): cadastro, execução físico-financeira, conformidade automática
com a Resolução nº 034/2025-TCE/RN e portal público de transparência.
Mesma arquitetura do SOFT+ Financeiro de Igrejas: Firebase (Auth +
Firestore) como backend, hospedagem estática no GitHub Pages.

## Arquivos
- `index.html` — telas do app
- `app.js` — toda a lógica (login, Firestore, telas, portal público)
- `firebase-config.js` — chaves do seu projeto Firebase (você precisa preencher)
- `firestore.rules` — regras de segurança (copiar para o Console do Firebase)
- `manifest.json` / `sw.js` — PWA (permite instalar o app)

Em **Dados do Ente**, cada ente pode ter sua própria logo (upload de imagem,
redimensionada automaticamente no navegador antes de salvar) — ela aparece
na barra lateral do app e no cabeçalho do Portal de Transparência público
desse ente.

## 1. Criar o projeto Firebase
Este é um sistema novo — **não reaproveite** o projeto do app da igreja.

1. Vá em **console.firebase.google.com** → crie um projeto novo
2. **Authentication** → Sign-in method → ative **E-mail/senha**
3. **Firestore Database** → criar banco → modo produção
4. **Configurações do projeto** → "Seus aplicativos" → criar app da Web (`</>`)
   → copie o objeto de configuração
5. Cole esse objeto em `firebase-config.js`, substituindo os campos `COLE_AQUI`

## 2. Colocar as regras de segurança no ar
1. Console do Firebase → **Firestore Database** → aba **Regras**
2. Apague o conteúdo padrão e cole o conteúdo de `firestore.rules`
3. Clique em **Publicar**

## 3. Publicar no GitHub Pages
1. Crie um repositório novo no GitHub
2. Suba todos os arquivos deste pacote
3. **Settings → Pages** → Source → branch `main`, pasta `/ (root)`
4. Em 1–2 minutos o app estará em `https://seu-usuario.github.io/nome-do-repo/`

⚠️ No Firebase, vá em **Authentication → Settings → Domínios autorizados** e
adicione `seu-usuario.github.io` — senão o login falha.

`firebase-config.js` pode ir para o repositório sem problema, mesmo que o
repositório seja público — essas chaves não são segredo. Quem protege os
dados de verdade são as **Regras do Firestore**, não a chave de API.

## 4. Primeiro acesso
1. Abra o link do GitHub Pages
2. Clique em **"Criar conta"**, informe nome, e-mail e senha
3. Você cai na tela de criação do primeiro ente — cadastre o Governo do
   Estado ou a primeira Prefeitura
4. Pronto: você já é **Administrador** dele

## 5. Adicionando outros entes e usuários
- Qualquer usuário logado pode criar um novo ente pelo menu **"+ Novo Ente"**
  (vira admin dele)
- Para dar acesso a outra pessoa: **Usuários → "+ Cadastrar usuário"** —
  informe nome, e-mail e uma senha temporária, escolha o papel e as abas.
  A conta já é criada na hora; passe e-mail e senha pra pessoa (ela entra
  direto, sem precisar "criar conta")
- Se o e-mail informado **já tiver conta** no app (de outro ente, por
  exemplo), o app cria um **convite** automaticamente em vez de dar erro —
  quando essa pessoa entrar com a conta que já tem, o acesso a este ente
  libera sozinho. Convites pendentes aparecem numa lista própria na tela de
  Usuários, com botão de cancelar
- **Editar usuário** — mude nome, papel e abas de qualquer pessoa a
  qualquer momento pelo botão "Editar" na lista. Por segurança, você não
  consegue alterar seu **próprio** papel por essa tela (evita ficar sem
  ninguém com acesso total ao ente por acidente)
- **Redefinir senha** — dentro de "Editar usuário" há um botão que envia um
  e-mail de redefinição de senha para a pessoa (não é possível definir a
  senha de uma conta já existente diretamente, por segurança)
- **Troca de senha obrigatória** — ao cadastrar ou editar um usuário, marque
  "pedir para trocar a senha no próximo acesso"; a pessoa verá uma tela
  obrigatória de nova senha assim que entrar
- Um mesmo usuário pode ter papéis diferentes em entes diferentes — o
  troca-ente fica no topo da barra lateral

## 6. Papéis e permissões
- **Administrador** — acesso total: cadastra emendas, lança execução,
  gerencia usuários, bloqueia exercício, edita dados do ente
- **Cadastrador** — lança/edita emendas e execução nas abas liberadas
- **Controle Interno** — lê tudo (mesmo sem a aba marcada) e pode **validar**
  uma etapa de execução, sem poder alterar o valor lançado por quem cadastrou
- **Leitura** — só visualiza as abas liberadas

Abas configuráveis: Emendas, Execução, Conformidade, Relatórios, Exercícios
Financeiros. Painel e Dados do Ente ficam sempre visíveis; Usuários é sempre
exclusivo de Administrador.

## 7. Conformidade (os 16 quesitos do TCE-RN) + Rastreabilidade

Duas checklists separadas aparecem dentro de cada emenda:

**a) Conformidade técnica (16 quesitos do Relatório de Levantamento)** — os
mesmos do questionário aplicado no Processo 000024/2026-TC, item 22 em
diante, divididos em:
- **5 quesitos de nível ENTE** (tem página, declaração negativa, página sem
  dados, apresenta emendas estaduais, apresenta emendas municipais) — como
  neste app a "página de emendas" é o próprio cadastro, os três primeiros
  são derivados da mesma condição: existe pelo menos uma emenda pública, ou
  há declaração negativa marcada para o exercício.
- **11 quesitos de nível EMENDA** (parlamentar, partido, origem, número,
  ato normativo, objeto, valor, órgão executor, localidade, cronograma,
  instrumentos vinculados) — cada um mapeado 1:1 a um campo do formulário.

**b) Rastreabilidade (itens do Acórdão, fora do escopo técnico original)**
— o próprio relatório deixou esses pontos de fora de propósito ("não foram
objeto de exames substantivos... elementos que deverão ser auditados em
etapas subsequentes" — item 3), mas o Acórdão determina adequação a eles
também:
- **Identificação do beneficiário final** — campo próprio na emenda,
  separado da localidade (onde) e do órgão executor (quem executa)
- **Metas previstas quantificadas** — descrição + quantidade + unidade
- **% de atingimento da meta** — calculado a partir da quantidade
  realizada acumulada, lançada em cada etapa de execução
- **Execução física e financeira atualizada** — consolidada
  automaticamente a partir das etapas lançadas (empenho/liquidação/
  pagamento) em cada emenda, sem precisar digitar de novo
- **Documentação comprobatória vinculada** — agora é upload de verdade
  (base64 direto no Firestore, sem custo de Storage — limite de ~600KB por
  arquivo), não só um texto de referência

Quando os 11 quesitos técnicos de uma emenda batem 100%, o botão **"Emitir
Certidão de Regularidade"** libera um PDF simples com os dados da emenda.

## 8. Acompanhamento Consolidado
Tela nova (aba própria, configurável por usuário) que soma, por exercício,
o valor previsto, empenhado, liquidado e pago de todas as emendas do ente
num só lugar — sem precisar abrir emenda por emenda. Os totais vêm de um
campo `resumoExecucao` que é recalculado automaticamente sempre que uma
etapa de execução é lançada, editada ou excluída (evita ter que reler todas
as subcoleções de execução toda vez que a tela abre).

## 9. Portal de Transparência (público, sem login)
Cada ente tem uma URL pública própria:
`https://seu-usuario.github.io/nome-do-repo/?portal=ID_DO_ENTE`

Você encontra esse link clicando em **"Ver Portal Público ↗"** na barra
lateral (abre em nova aba com a URL já pronta). Só aparecem lá as emendas
marcadas com **"Publicar no Portal de Transparência"** no formulário de
cadastro — isso é proposital: você decide o que fica público antes de
publicar, em vez de tudo ir para o ar automaticamente.

⚠️ Importante sobre a regra pública do Firestore: qualquer um com o link
consegue ler o **documento inteiro** da emenda marcada como pública (não dá
para "esconder" campos específicos por regra). Não guarde nenhuma
informação sensível/interna nos campos da emenda — se precisar de anotações
internas, crie um campo separado e não o inclua na tela pública nem marque
a emenda como pública até remover essa informação.

## Limitações desta primeira versão (dá pra evoluir depois)
- **Upload de comprovantes tem teto de ~600KB por arquivo** — é base64
  guardado direto no documento da execução (sem Storage pago), e o
  Firestore tem limite de 1MB por documento inteiro. Para PDFs grandes ou
  fotos em alta resolução, seria necessário migrar pra Firebase Storage
  (plano pago) — sinalizando aqui como já avisado no início do projeto
- Sem paginação nas listas — funciona bem até algumas centenas de emendas
  por ente; se crescer muito, dá pra portar a mesma técnica de paginação
  que o app da igreja usa em Fiéis/Lançamentos
- Sem assistente de importação de planilha antiga (dá pra adicionar depois,
  no mesmo padrão do importador do app da igreja)
- O checklist de conformidade de nível ENTE (os 5 primeiros quesitos, ver
  seção 7) é uma adaptação simplificada do questionário original — revisar
  com a equipe técnica do TCE-RN se precisar de fidelidade maior a como
  eles auditam hoje
- O "% de atingimento de metas" assume que a meta é um número único por
  emenda (ex: "500 metros de rede"), não metas por marco do cronograma —
  se uma emenda tiver metas diferentes em cada etapa, seria preciso separar
  o campo de meta por marco em vez de um valor só por emenda
- A recuperação de senha na tela de login ainda não tem um botão próprio
  ("esqueci minha senha") para quem já está logado tentando entrar — hoje
  isso só existe dentro de "Editar usuário" (um admin envia o e-mail de
  redefinição para a pessoa). Se precisar de autoatendimento na própria
  tela de login, dá pra adicionar um link ali usando o mesmo
  `sendPasswordResetEmail`

## Nota de segurança em relação ao app da igreja
Ao replicar o padrão de "cadastro direto de usuário" e "auto-vínculo no
bootstrap" do app da igreja, percebi que a regra original permitia, em
teoria, que qualquer usuário logado se auto-adicionasse como membro de
**qualquer** ente já existente (não só o que ele mesmo criou), bastando não
ter vínculo lá ainda — porque a regra só checava "o vínculo não existe",
não "fui eu quem criou este ente". Corrigi isso nas regras deste app
(função `criouEsteEnte`, em `firestore.rules`): agora o auto-cadastro sem
convite só funciona para quem criou o ente, exatamente no momento do
bootstrap. Vale considerar aplicar o mesmo ajuste no app da igreja depois.
