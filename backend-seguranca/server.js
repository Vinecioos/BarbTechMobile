import 'dotenv/config';
import fs from 'node:fs';
import nodemailer from 'nodemailer';
import admin from 'firebase-admin';
import { criarApp } from './src/app.js';
import { storeFirestore } from './src/store.js';
import { chaveDe } from './src/cripto.js';
import { fazerBackup, agendarBackup } from './scripts/backup.js';

// Hardening: sem valores padrão para segredos. Se faltar algo (ou ainda for o texto de exemplo), o serviço não sobe.
const exige = (nome) => {
  const v = process.env[nome];
  if (!v || /^(troque|cole|change|xxx)/i.test(v)) { console.error(`Variável ${nome} ausente ou ainda com o valor de exemplo. Veja .env.example.`); process.exit(1); }
  return v;
};

const chaveCripto = chaveDe(exige('CHAVE_CRIPTO'));
const chaveLog = exige('CHAVE_LOG');
const origens = exige('ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
const conta = JSON.parse(fs.readFileSync(exige('FIREBASE_SERVICE_ACCOUNT'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(conta) });
const db = admin.firestore();

// SMTP_URL=console: modo de demonstração em sala. O e-mail (com o código OTP) é escrito no terminal em vez de ser enviado.
// Nunca use em produção: quem lê o terminal lê o código.
let mailer;
if (process.env.SMTP_URL === 'console') {
  console.warn('*** MODO DEMONSTRAÇÃO: e-mails serão escritos neste terminal, não enviados. NÃO USE EM PRODUÇÃO. ***');
  mailer = { enviar: async (para, assunto, texto) => { console.log(`\n--- E-MAIL (demonstração) ---\nPara: ${para}\nAssunto: ${assunto}\n${texto}\n-----------------------------\n`); } };
} else {
  const transporte = nodemailer.createTransport(exige('SMTP_URL'));
  mailer = { enviar: (para, assunto, texto) => transporte.sendMail({ from: exige('EMAIL_REMETENTE'), to: para, subject: assunto, text: texto }) };
}

const app = criarApp({
  auth: admin.auth(), store: storeFirestore(db), mailer, chaveCripto, chaveLog, origens,
  dirLogs: process.env.DIR_LOGS || './logs', confiarProxy: Number(process.env.TRUST_PROXY || 0),
});

if (process.env.BACKUP_ATIVO !== '0') {
  const rodar = async () => { const f = await fazerBackup({ db, dir: process.env.DIR_BACKUP || './backups', chave: chaveCripto, retencaoDias: Number(process.env.BACKUP_RETENCAO_DIAS || 14) }); await app.auditar('backup_realizado', { detalhe: f.split('/').pop() }); };
  agendarBackup(rodar, Number(process.env.BACKUP_HORA || 3));
}

const porta = Number(process.env.PORT || 3100);
app.listen(porta, () => console.log(`Serviço de segurança BarbTech na porta ${porta}`));
