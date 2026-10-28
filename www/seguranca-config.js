// Configuração do serviço de segurança (backend-seguranca/).
// Deixe `url` vazio para rodar sem ele: o app continua funcionando com o bloqueio local de tentativas, a validação de senha e a
// expiração por inatividade, mas SEM o código de recuperação da conta e SEM recuperação de senha por código (OTP).
// Exemplos de url:  'https://seguranca.seudominio.com'   |   'http://10.0.2.2:3100' (emulador Android, só para testes)
export const segurancaConfig = {
  url: '',
  inatividadeMin: 120,          // minutos sem uso até encerrar a sessão
  contatoPrivacidade: 'barbtech@gmail.com'       // e-mail do responsável pelos dados (aparece na política de privacidade)
};
