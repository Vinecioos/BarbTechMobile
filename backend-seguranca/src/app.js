// BarbTech — serviço de segurança. Tudo que o app não pode garantir sozinho (porque roda no aparelho do usuário) fica aqui:
// bloqueio de login por tentativas, OTP e código único de recuperação de senha, auditoria e rate limiting.
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  hashSegredo, confereSegredo, pseudonimo, sha256, codigoNumerico, codigoRecuperacao, avaliarSenha,
} from './cripto.js';

const MIN = 60_000;
export const CFG = {
  maxFalhasLogin: 5, bloqueioLoginMs: 15 * MIN,
  otpValidadeMs: 10 * MIN, otpMaxTentativas: 5, otpReenvioMs: 60_000,
  recMaxFalhas: 5, recBloqueioMs: 15 * MIN, loginRecenteMs: 10 * MIN,
};

const EMAIL = z.string().trim().toLowerCase().email().max(120);
const EVENTOS_CLIENTE = ['logout', 'consentimento_alterado', 'dados_exportados', 'conta_excluida', 'senha_alterada_app'];

// deps: { auth, store, mailer, chaveCripto (Buffer), chaveLog (string), origens (array), dirLogs, agora, confiarProxy }
export function criarApp(deps) {
  const { auth, store, mailer, chaveLog } = deps;
  const agora = deps.agora || (() => Date.now());
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.confiarProxy ?? 0);
  app.use(helmet());

  // CORS: só as origens listadas (sem lista, nada de navegador é aceito). O app Capacitor usa https://localhost ou capacitor://localhost.
  const origens = deps.origens || [];
  app.use((req, res, next) => {
    const o = req.headers.origin;
    if (o && !origens.includes(o)) return res.status(403).json({ erro: 'Origem não autorizada.' });
    next();
  });
  app.use(cors({ origin: origens, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 600 }));
  app.use(express.json({ limit: '8kb' }));

  /* ---------- rate limit por IP (global e por rota sensível) ---------- */
  const porIp = (max, janelaMs, msg) => rateLimit({ windowMs: janelaMs, limit: max, standardHeaders: true, legacyHeaders: false, message: { erro: msg } });
  app.use(porIp(120, MIN, 'Muitas requisições. Aguarde um instante.'));
  const limOtpSolicitar = porIp(5, 15 * MIN, 'Muitas solicitações de código. Tente mais tarde.');
  const limOtpRedefinir = porIp(10, 15 * MIN, 'Muitas tentativas. Tente mais tarde.');
  const limLogin = porIp(30, 15 * MIN, 'Muitas tentativas. Tente mais tarde.');
  const limRec = porIp(20, 15 * MIN, 'Muitas tentativas. Tente mais tarde.');
  const limRecRedefinir = porIp(10, 15 * MIN, 'Muitas tentativas. Tente mais tarde.');

  // rate limit por usuário/e-mail (memória do processo; com várias instâncias, troque por Redis)
  const janelas = new Map();
  function limitaChave(chave, max, janelaMs) {
    const t = agora(), v = (janelas.get(chave) || []).filter((x) => t - x < janelaMs);
    if (v.length >= max) { janelas.set(chave, v); return false; }
    v.push(t); janelas.set(chave, v); return true;
  }

  /* ---------- auditoria: Firestore + arquivo, com encadeamento de hash (adulterar uma linha quebra as seguintes) ---------- */
  let ultimoHash = 'genesis';
  async function auditar(evento, { uid = null, email = null, ip = null, detalhe = null } = {}) {
    const reg = {
      ts: new Date(agora()).toISOString(), evento,
      uid: uid || null,
      usuario: email ? pseudonimo(email, chaveLog) : null,                      // e-mail nunca em texto puro
      ip: ip ? String(ip).replace(/(\d+\.\d+\.\d+)\.\d+$/, '$1.0').replace(/(:[0-9a-f]*){2}$/i, ':0:0') : null,   // IP mascarado (LGPD)
      detalhe: detalhe ? String(detalhe).slice(0, 120) : null,
    };
    reg.anterior = ultimoHash;
    reg.hash = sha256(ultimoHash + JSON.stringify([reg.ts, reg.evento, reg.uid, reg.usuario, reg.ip, reg.detalhe]));
    ultimoHash = reg.hash;
    try { await store.add('auditoria', reg); } catch (e) { console.error('[auditoria] store', e?.code || e?.name); }
    if (deps.dirLogs) {
      try {
        fs.mkdirSync(deps.dirLogs, { recursive: true });
        fs.appendFileSync(path.join(deps.dirLogs, `auditoria-${reg.ts.slice(0, 10)}.jsonl`), JSON.stringify(reg) + '\n', { mode: 0o600 });
      } catch (e) { console.error('[auditoria] arquivo', e?.code || e?.name); }
    }
  }

  /* ---------- autenticação (ID token do Firebase) ---------- */
  async function exigeLogin(req, res, next) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ erro: 'Sessão inválida.' });
    try {
      const t = await auth.verifyIdToken(m[1], true);
      req.uid = t.uid; req.email = t.email || null; req.claims = t;
      next();
    } catch { res.status(401).json({ erro: 'Sessão inválida.' }); }
  }

  const ip = (req) => req.ip;
  const chaveEmail = (email) => sha256(email.toLowerCase());
  const entrada = (schema, req, res) => { const p = schema.safeParse(req.body); if (!p.success) { res.status(400).json({ erro: 'Dados inválidos.' }); return null; } return p.data; };
  const assinc = (fn) => (req, res, next) => fn(req, res, next).catch(next);

  app.get('/health', (_req, res) => res.json({ ok: true }));

  /* =====================  BLOQUEIO TEMPORÁRIO DE LOGIN  ===================== */
  async function estadoBloqueio(email) {
    const r = await store.get('tentativasLogin', chaveEmail(email));
    const t = agora();
    if (r && r.bloqueadoAte && r.bloqueadoAte > t) return { bloqueado: true, restanteSeg: Math.ceil((r.bloqueadoAte - t) / 1000) };
    return { bloqueado: false, restanteSeg: 0, reg: r };
  }
  app.post('/api/seg/pode-entrar', limLogin, assinc(async (req, res) => {
    const b = entrada(z.object({ email: EMAIL }).strict(), req, res); if (!b) return;
    const e = await estadoBloqueio(b.email);
    res.json({ bloqueado: e.bloqueado, restanteSeg: e.restanteSeg });
  }));
  app.post('/api/seg/falha-login', limLogin, assinc(async (req, res) => {
    const b = entrada(z.object({ email: EMAIL }).strict(), req, res); if (!b) return;
    const k = chaveEmail(b.email), e = await estadoBloqueio(b.email);
    if (e.bloqueado) return res.json({ bloqueado: true, restanteSeg: e.restanteSeg, restantes: 0 });
    const falhas = ((e.reg && e.reg.falhas) || 0) + 1;
    const bloquear = falhas >= CFG.maxFalhasLogin;
    await store.set('tentativasLogin', k, { falhas: bloquear ? 0 : falhas, bloqueadoAte: bloquear ? agora() + CFG.bloqueioLoginMs : 0 });
    await auditar(bloquear ? 'login_bloqueado' : 'login_falhou', { email: b.email, ip: ip(req) });
    res.json({ bloqueado: bloquear, restanteSeg: bloquear ? CFG.bloqueioLoginMs / 1000 : 0, restantes: Math.max(0, CFG.maxFalhasLogin - falhas) });
  }));
  app.post('/api/seg/sucesso-login', exigeLogin, assinc(async (req, res) => {
    if (req.email) await store.del('tentativasLogin', chaveEmail(req.email));
    await auditar('login_ok', { uid: req.uid, email: req.email, ip: ip(req) });
    res.json({ ok: true });
  }));

  /* =====================  RECUPERAÇÃO DE SENHA POR OTP  ===================== */
  app.post('/api/otp/solicitar', limOtpSolicitar, assinc(async (req, res) => {
    const b = entrada(z.object({ email: EMAIL }).strict(), req, res); if (!b) return;
    const k = chaveEmail(b.email);
    const resposta = { ok: true, mensagem: 'Se o e-mail estiver cadastrado, enviamos um código de 6 dígitos válido por 10 minutos.' };   // sempre igual: não revela quem tem conta
    if (!limitaChave('otp:' + k, 3, 60 * MIN)) { await auditar('otp_limite', { email: b.email, ip: ip(req) }); return res.json(resposta); }
    const atual = await store.get('otp', k);
    if (atual && agora() - atual.criadoEm < CFG.otpReenvioMs) return res.json(resposta);
    let usuario = null;
    try { usuario = await auth.getUserByEmail(b.email); } catch { /* não existe */ }
    const codigo = codigoNumerico(6);
    const hash = await hashSegredo(codigo);   // bcrypt roda também quando a conta não existe (tempo de resposta parecido)
    if (usuario) {
      await store.set('otp', k, { hash, uid: usuario.uid, criadoEm: agora(), expira: agora() + CFG.otpValidadeMs, tentativas: 0 });
      try { await mailer.enviar(b.email, 'Seu código de recuperação — BarbTech',
        `Seu código para redefinir a senha é ${codigo}.\n\nEle vale por 10 minutos e só pode ser usado uma vez. Se você não pediu, ignore este e-mail: sua senha continua a mesma.`); }
      catch (e) { console.error('[email]', e?.code || e?.name); await auditar('otp_email_falhou', { uid: usuario.uid, ip: ip(req) }); return res.json(resposta); }
    }
    await auditar('otp_solicitado', { uid: usuario?.uid, email: b.email, ip: ip(req) });
    res.json(resposta);
  }));

  app.post('/api/otp/redefinir', limOtpRedefinir, assinc(async (req, res) => {
    const b = entrada(z.object({ email: EMAIL, codigo: z.string().regex(/^\d{6}$/), novaSenha: z.string().min(1).max(128) }).strict(), req, res); if (!b) return;
    const generico = () => res.status(400).json({ erro: 'Código inválido ou expirado.' });
    const k = chaveEmail(b.email);
    const reg = await store.get('otp', k);
    if (!reg || reg.expira < agora()) { await auditar('otp_invalido', { email: b.email, ip: ip(req), detalhe: 'inexistente/expirado' }); return generico(); }
    if (reg.tentativas >= CFG.otpMaxTentativas) { await store.del('otp', k); await auditar('otp_invalido', { uid: reg.uid, ip: ip(req), detalhe: 'tentativas esgotadas' }); return generico(); }
    if (!(await confereSegredo(b.codigo, reg.hash))) {
      await store.set('otp', k, { ...reg, tentativas: reg.tentativas + 1 });
      await auditar('otp_invalido', { uid: reg.uid, ip: ip(req), detalhe: 'código errado' });
      return generico();
    }
    if (!avaliarSenha(b.novaSenha).ok) return res.status(400).json({ erro: 'A nova senha não atende às regras de segurança.' });
    await store.del('otp', k);   // uso único
    await auth.updateUser(reg.uid, { password: b.novaSenha });
    await auth.revokeRefreshTokens(reg.uid);   // derruba as sessões abertas
    await store.del('tentativasLogin', k);
    await auditar('senha_redefinida_otp', { uid: reg.uid, email: b.email, ip: ip(req) });
    res.json({ ok: true });
  }));

  /* =====================  CÓDIGO ÚNICO DE RECUPERAÇÃO  =====================
     No cadastro o app pede um código ao serviço; ele aparece uma única vez na tela e só o próprio usuário o conhece.
     Aqui fica apenas o hash (bcrypt): nem a equipe consegue ler o código. Com ele a pessoa redefine a senha sem e-mail. */
  const formataCodigo = (c) => c.match(/.{4}/g).join('-');
  const normalizaCodigo = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const CODIGO_REC = z.string().min(8).max(32);
  async function emitirCodigo(uid) {
    const codigo = formataCodigo(codigoRecuperacao(16));
    await store.set('codigoRec', uid, { hash: await hashSegredo(normalizaCodigo(codigo)), criadoEm: agora(), falhas: 0, bloqueadoAte: 0 });
    return codigo;
  }

  app.get('/api/recuperacao/status', limRec, exigeLogin, assinc(async (req, res) => {
    const r = await store.get('codigoRec', req.uid);
    res.json({ temCodigo: !!r, criadoEm: r ? r.criadoEm : null });
  }));

  // Gera o código (cadastro) ou troca por um novo (o anterior deixa de valer). Trocar exige login recente.
  app.post('/api/recuperacao/gerar', limRec, exigeLogin, assinc(async (req, res) => {
    const r = await store.get('codigoRec', req.uid);
    if (r) {
      const recente = Number(req.claims.auth_time) * 1000 > agora() - CFG.loginRecenteMs;
      if (!recente) return res.status(403).json({ erro: 'Por segurança, saia e entre de novo para gerar um novo código.' });
    }
    const codigo = await emitirCodigo(req.uid);
    await auditar(r ? 'codigo_recuperacao_renovado' : 'codigo_recuperacao_criado', { uid: req.uid, email: req.email, ip: ip(req) });
    res.json({ ok: true, codigo });   // mostrado uma única vez
  }));

  app.post('/api/recuperacao/redefinir', limRecRedefinir, assinc(async (req, res) => {
    const b = entrada(z.object({ email: EMAIL, codigo: CODIGO_REC, novaSenha: z.string().min(1).max(128) }).strict(), req, res); if (!b) return;
    const generico = () => res.status(400).json({ erro: 'E-mail ou código de recuperação inválido.' });   // mesma resposta para e-mail inexistente e código errado
    if (!limitaChave('rec:' + chaveEmail(b.email), 10, 15 * MIN)) { await auditar('recuperacao_limite', { email: b.email, ip: ip(req) }); return res.status(429).json({ erro: 'Muitas tentativas. Tente novamente mais tarde.' }); }
    let usuario = null;
    try { usuario = await auth.getUserByEmail(b.email); } catch { /* não existe */ }
    const reg = usuario ? await store.get('codigoRec', usuario.uid) : null;
    if (reg && reg.bloqueadoAte && reg.bloqueadoAte > agora()) { await auditar('recuperacao_bloqueada', { uid: usuario.uid, ip: ip(req) }); return res.status(429).json({ erro: 'Muitas tentativas. Tente novamente mais tarde.' }); }
    const ok = await confereSegredo(normalizaCodigo(b.codigo), reg && reg.hash);   // roda o bcrypt mesmo sem conta: tempo parecido
    if (!usuario || !reg || !ok) {
      if (usuario && reg) {
        const falhas = (reg.falhas || 0) + 1, trava = falhas >= CFG.recMaxFalhas;
        await store.set('codigoRec', usuario.uid, { ...reg, falhas: trava ? 0 : falhas, bloqueadoAte: trava ? agora() + CFG.recBloqueioMs : 0 });
      }
      await auditar('recuperacao_invalida', { uid: usuario?.uid, email: b.email, ip: ip(req) });
      return generico();
    }
    if (!avaliarSenha(b.novaSenha).ok) return res.status(400).json({ erro: 'A nova senha não atende às regras de segurança.' });   // não gasta o código
    await auth.updateUser(usuario.uid, { password: b.novaSenha });
    await auth.revokeRefreshTokens(usuario.uid);   // derruba as sessões abertas
    await store.del('tentativasLogin', chaveEmail(b.email));
    const novoCodigo = await emitirCodigo(usuario.uid);   // uso único: o código usado morre e nasce outro
    await auditar('senha_redefinida_codigo', { uid: usuario.uid, email: b.email, ip: ip(req) });
    res.json({ ok: true, novoCodigo });
  }));

  /* =====================  AUDITORIA enviada pelo app (eventos que só o app conhece)  ===================== */
  app.post('/api/auditoria', limLogin, exigeLogin, assinc(async (req, res) => {
    const b = entrada(z.object({ evento: z.enum(EVENTOS_CLIENTE) }).strict(), req, res); if (!b) return;
    await auditar(b.evento, { uid: req.uid, email: req.email, ip: ip(req) });
    res.json({ ok: true });
  }));

  // tratador final: nunca devolve stack trace nem mensagem interna
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ erro: 'Requisição inválida.' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ erro: 'Requisição inválida.' });
    console.error('[erro]', err?.code || err?.name || 'desconhecido');
    res.status(500).json({ erro: 'Não foi possível concluir agora. Tente novamente.' });
  });

  app.auditar = auditar;
  return app;
}
