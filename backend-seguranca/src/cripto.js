// Primitivas de segurança: hash (bcrypt), criptografia (AES-256-GCM), códigos aleatórios e política de senha.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

/* ---------- hash de segredos curtos (OTP, códigos de recuperação) ---------- */
const CUSTO_BCRYPT = 10;
export const hashSegredo = (txt) => bcrypt.hash(String(txt), CUSTO_BCRYPT);
export const confereSegredo = (txt, hash) => bcrypt.compare(String(txt), String(hash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid.'));

/* ---------- AES-256-GCM: v1:iv:tag:texto (base64) ---------- */
export function chaveDe(b64) {
  const k = Buffer.from(String(b64 || ''), 'base64');
  if (k.length !== 32) throw new Error('CHAVE_CRIPTO deve ter 32 bytes em base64 (veja .env.example).');
  return k;
}
export function cifrar(texto, chave) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const ct = Buffer.concat([c.update(Buffer.isBuffer(texto) ? texto : Buffer.from(String(texto), 'utf8')), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
export function decifrar(blob, chave, comoBuffer = false) {
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') throw new Error('formato inválido');
  const d = crypto.createDecipheriv('aes-256-gcm', chave, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  const out = Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]);
  return comoBuffer ? out : out.toString('utf8');
}

/* ---------- pseudonimização para logs (HMAC): o e-mail nunca vai em texto puro para o log ---------- */
export const pseudonimo = (valor, chave) => crypto.createHmac('sha256', chave).update(String(valor).toLowerCase().trim()).digest('hex').slice(0, 24);
export const sha256 = (txt) => crypto.createHash('sha256').update(String(txt)).digest('hex');

/* ---------- códigos aleatórios ---------- */
export const codigoNumerico = (n = 6) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
const ALF = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const codigoRecuperacao = (n = 10) => Array.from({ length: n }, () => ALF[crypto.randomInt(0, ALF.length)]).join('');

/* ---------- política de senha (a mesma do front: 8+ caracteres, maiúscula, minúscula, número e especial) ---------- */
export function avaliarSenha(s) {
  s = String(s || '');
  const r = {
    tamanho: s.length >= 8,
    maiuscula: /[A-ZÀ-Ý]/.test(s),
    minuscula: /[a-zß-ÿ]/.test(s),
    numero: /\d/.test(s),
    especial: /[^A-Za-zÀ-ÿ0-9\s]/.test(s),
  };
  return { ok: Object.values(r).every(Boolean) && s.length <= 128, regras: r };
}

/* ---------- sanitização de texto livre ---------- */
export const limpar = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
