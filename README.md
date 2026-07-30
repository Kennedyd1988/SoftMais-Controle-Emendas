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
- **Metas físicas previstas (quantas quiser por emenda)** — cada uma com
  descrição, quantidade e unidade. Uma emenda pode ter várias metas
  (ex: "500m de rede de água" + "200 famílias atendidas")
- **Execução física = atendimento médio das metas** — na tela de Execução,
  cada etapa lançada pede a quantidade acumulada realizada de *cada* meta
  cadastrada. O app calcula sozinho o % físico da emenda como a média do
  % de atingimento de cada meta — não é mais um número digitado à mão.
  Se a emenda não tiver nenhuma meta cadastrada, o app volta ao
  comportamento antigo (% físico digitado manualmente por etapa)
- **Execução financeira atualizada** — consolidada automaticamente a
  partir das etapas lançadas (empenho/liquidação/pagamento) em cada
  emenda, sem precisar digitar de novo
- **Documentação comprobatória vinculada** — agora é upload de verdade
  (base64 direto no Firestore, sem custo de Storage — limite de ~600KB por
  arquivo), não só um texto de referência

⚠️ **Nota de migração**: emendas cadastradas antes desta versão usavam um
campo de meta única (`metaFisica`). Esse campo antigo continua salvo no
banco, mas o app agora lê e mostra apenas o novo campo `metas` (lista). Se
você já tinha cadastrado uma meta em alguma emenda, precisa recadastrá-la
na tela de edição da emenda, no bloco "Metas físicas previstas".

⚠️ **Outra nota de migração**: se você já tinha lançado alguma "etapa de
execução" (empenho/liquidação/pagamento separados) antes desta versão,
esses registros ficaram salvos na subcoleção antiga `execucoes` e **não
aparecem mais no app** — a tela agora lê da nova subcoleção `despesas`
(registro único por despesa). Não são muitos dados normalmente (é recente),
mas relance essas despesas na tela nova, se for o caso.

Quando os 11 quesitos técnicos de uma emenda batem 100%, o botão **"Emitir
Certidão de Regularidade"** libera um PDF simples com os dados da emenda.

## 8. Acompanhamento Consolidado
Tela nova (aba própria, configurável por usuário) que soma, por exercício,
o valor previsto, recebido (receita), empenhado e pago de todas as emendas
do ente num só lugar — sem precisar abrir emenda por emenda. Os totais vêm
de um campo `resumoExecucao` que é recalculado automaticamente sempre que
uma despesa ou receita é lançada, editada ou excluída (evita ter que reler
todas as subcoleções de cada emenda toda vez que a tela abre).

## 9. Portal de Transparência (público, sem login)
Cada ente tem uma URL pública própria:
`https://seu-usuario.github.io/nome-do-repo/?portal=ID_DO_ENTE`

Você encontra esse link clicando em **"Ver Portal Público ↗"** na barra
lateral (abre em nova aba com a URL já pronta). Só aparecem lá as emendas
marcadas com **"Publicar no Portal de Transparência"** no formulário de
cadastro — isso é proposital: você decide o que fica público antes de
publicar, em vez de tudo ir para o ar automaticamente.

O portal foi redesenhado pra ficar mais organizado e visual:
- **Cartões de resumo** no topo (quantas emendas públicas, valor previsto,
  recebido, empenhado, pago), já considerando os filtros aplicados
- **Gráfico de barras** (Chart.js) comparando previsto × recebido ×
  empenhado × pago do conjunto filtrado
- **Barras de progresso** de execução física e financeira em cada cartão
  de emenda — cor verde quando bate 100%, senão azul/amarelo
- **Barras de progresso por meta física**, mostrando quanto já foi
  entregue de cada meta
- Detalhes (autor, partido, ato normativo, órgão executor, localidade,
  beneficiário final, valores) organizados em grade, com botão pra abrir o
  histórico completo de despesas e receitas (com documentos) só quando a
  pessoa quiser ver

⚠️ **Dados bancários nunca aparecem no Portal Público**, mesmo que a
emenda esteja marcada como pública — isso foi proposital: divulgar
agência/conta publicamente é um vetor comum de fraude (golpes se passando
pelo fornecedor pra pedir troca de conta de pagamento). Os dados bancários
ficam só dentro do app, visíveis apenas a quem tem login no ente.

⚠️ Importante sobre a regra pública do Firestore: qualquer um com o link
consegue ler o **documento inteiro** da emenda marcada como pública (não dá
para "esconder" campos específicos por regra). Não guarde nenhuma
informação sensível/interna nos campos da emenda — se precisar de anotações
internas, crie um campo separado e não o inclua na tela pública nem marque
a emenda como pública até remover essa informação.

## 10. Despesas, Receitas, Dados Bancários e Importação de Planilhas

**Dados bancários** — cada emenda tem um bloco de banco/agência/conta/tipo
de conta, referente à conta usada para receber e executar o recurso.

**Despesas** — substituíram a antiga "Execução" por etapas separadas.
Agora **cada despesa é um único registro** cobrindo empenho + liquidação +
pagamento juntos, com todos os campos de rastreabilidade: número do
empenho, credor, CNPJ, dotação orçamentária, elemento de despesa, unidade
orçamentária, conta bancária, valores (empenhado e liquidado/pago), ordem
de pagamento, data, histórico, contrato, nota fiscal, modalidade e processo
de licitação. Cada despesa pode ser vinculada a quantas metas físicas a
emenda tiver, informando a quantidade que aquela despesa específica
entregou de cada meta.

- **Execução física** = soma das quantidades entregues (em todas as
  despesas) para cada meta, dividida pela quantidade prevista — não é mais
  digitada à mão.
- **Execução financeira** = valor pago dividido pelo valor total da
  emenda — também automática.

**Receitas** — nova aba dentro de cada emenda, pra registrar quando o
valor da emenda é efetivamente recebido (data, valor, conta bancária de
recebimento, origem do recurso, documento comprobatório).

**Editar despesas e receitas** — ambas agora têm botão **"Editar"** na
listagem (junto do "Excluir"), abrindo o mesmo formulário já preenchido.
Se você não escolher um novo arquivo ao editar, o comprovante anexado
anteriormente é mantido; só é substituído se um arquivo novo for
selecionado. A execução física/financeira da emenda é recalculada
automaticamente depois de qualquer edição, do mesmo jeito que ao lançar ou
excluir.

**Importação de despesas por planilha** — dentro de cada emenda, no card
"Despesas": botão **"⬇ Baixar modelo"** gera um Excel com a aba de
instruções e as colunas exatas usadas pelos sistemas contábeis municipais
(EMPENHO, NOME, CFPRO, CATEC, UNIDADENOME, UNIDADE, CONTAC, VAPAG, ORDPG,
DTLAN, HISTORICO, CONTRATO, LICMOD, PROCLIC, NOTAFISCAL, VALOREMPENHO,
CNPJFORNECEDOR, PARCELA). O botão **"⬆ Importar planilha"** aceita esse
mesmo formato em `.xlsx` ou `.csv` (separado por `;`, igual ao exportado
pelo sistema de contabilidade). **Duplicados são bloqueados
automaticamente** — a chave usada é `número do empenho + parcela + nota
fiscal`; uma linha que já foi importada antes é pulada e contabilizada no
resumo da importação, não é lançada de novo. As metas físicas não vêm da
planilha (o formato de origem não tem essa informação) — vincule
manualmente em cada despesa depois, se precisar que a execução física
considere aquele lançamento.

**Importação/exportação de emendas** — na tela de listagem de Emendas,
botão **"⬇ Baixar modelo"** gera um Excel próprio (esfera, exercício,
número, autor, partido, objeto, valor, ato normativo, órgão executor,
localidade, beneficiário final, dados bancários) com aba de instruções e
linha de exemplo. O botão **"⬆ Importar emendas"** lê esse modelo
preenchido e cadastra em lote — também bloqueia duplicados (mesma
combinação de número + exercício não é importada duas vezes). A exportação
de emendas já cadastradas continua disponível em **Relatórios → Exportar
XLSX**.

## 11. Anexos no Google Drive (opcional)
Por padrão, os comprovantes de despesas/receitas são salvos como base64
direto no Firestore, com limite de ~600KB por arquivo (ver seção de
limitações). Se isso for pouco, cada ente pode configurar upload direto
para uma pasta do Google Drive — sem precisar de servidor próprio, o
upload acontece direto do navegador pra API do Google.

**Como configurar (uma vez por ente):**
1. Acesse **console.cloud.google.com** → crie um projeto nesse ou use um já existente
2. **APIs e serviços → Biblioteca** → busque e ative **"Google Drive API"**
3. **APIs e serviços → Tela de permissão OAuth** → configure como "Externo",
   preencha os campos obrigatórios (nome do app, e-mail) e publique
4. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**
   → tipo "Aplicativo da Web" → em "Origens JavaScript autorizadas",
   adicione `https://seu-usuario.github.io` (sem barra no final)
5. Copie o **Client ID** gerado (termina em `.apps.googleusercontent.com`)
6. No Google Drive, crie (ou escolha) uma pasta para os anexos e copie o
   ID dela a partir da URL (a parte depois de `/folders/`)
7. No app: **Dados do Ente → Anexos no Google Drive** → cole o Client ID e
   o ID da pasta → **Salvar configuração do Drive**

A partir daí, sempre que alguém for anexar um documento numa despesa ou
receita, o navegador vai pedir login e permissão do Google na hora (usa o
escopo `drive.file`, que só dá acesso aos arquivos que o próprio app cria
— nunca ao Drive inteiro da pessoa). O link do arquivo fica salvo no
lançamento e aparece também no Portal Público, se a emenda for pública.

⚠️ Isso é opcional — sem configurar nada, os anexos continuam funcionando
normalmente (só com o limite de 600KB por arquivo).

## Limitações desta primeira versão (dá pra evoluir depois)
- **Upload de comprovantes sem Google Drive configurado tem teto de
  ~600KB por arquivo** — é base64 guardado direto no documento (sem
  Storage pago), e o Firestore tem limite de 1MB por documento inteiro.
  Configure o Google Drive (seção 11) se precisar de arquivos maiores
- Sem paginação nas listas — funciona bem até algumas centenas de emendas
  por ente; se crescer muito, dá pra portar a mesma técnica de paginação
  que o app da igreja usa em Fiéis/Lançamentos
- O checklist de conformidade de nível ENTE (os 5 primeiros quesitos, ver
  seção 7) é uma adaptação simplificada do questionário original — revisar
  com a equipe técnica do TCE-RN se precisar de fidelidade maior a como
  eles auditam hoje
- A importação de despesas não traz vínculo com metas físicas (o formato
  de planilha de origem não tem essa informação) — precisa vincular
  manualmente depois de importar, em cada despesa que afete uma meta
- A importação de emendas e despesas roda linha por linha (não em lote de
  verdade no Firestore) — funciona bem para dezenas/poucas centenas de
  linhas por vez; para volumes muito grandes pode demorar alguns minutos
- O Google Drive usa autorização OAuth por sessão — cada pessoa que for
  anexar um arquivo precisa autorizar com a própria conta Google na hora
  (não há uma "conta única" compartilhada automaticamente); o token dura
  a sessão do navegador
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
