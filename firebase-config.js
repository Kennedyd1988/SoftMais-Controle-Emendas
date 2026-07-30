// Configuração do projeto Firebase deste app (SOFT+ Emendas Parlamentares)
// Essas chaves não são secretas — a segurança real fica nas Regras do
// Firestore (arquivo firestore.rules), que controlam quem pode ler/escrever.
//
// COMO PREENCHER:
// 1. Crie um projeto NOVO em console.firebase.google.com (não reaproveite o
//    projeto do app da igreja — são sistemas separados)
// 2. Ative Authentication → método "E-mail/senha"
// 3. Crie um banco Firestore (modo produção)
// 4. Em "Configurações do projeto" → role até "Seus aplicativos" → crie um
//    app da Web (</>) → copie o objeto de configuração e cole abaixo
export const firebaseConfig = {
  apiKey: "COLE_AQUI",
  authDomain: "COLE_AQUI.firebaseapp.com",
  projectId: "COLE_AQUI",
  storageBucket: "COLE_AQUI.firebasestorage.app",
  messagingSenderId: "COLE_AQUI",
  appId: "COLE_AQUI"
};
