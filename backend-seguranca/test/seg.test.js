import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { criarApp } from '../src/app.js';
import { storeMemoria } from '../src/store.js';
import { cifrar, decifrar, avaliarSenha, limpar } from '../src/cripto.js';
import { fazerBackup, lerBackup } from '../scripts/backup.js';

const chave = crypto.randomBytes(32);
function montar(extra = {}) {
  const store = storeMemoria(), emails = [];
  const usuarios = { u1: { uid: 'u1', email: 'ana@teste.com', senha: 'Antiga#123', claims: {}, revogado: 0 } };
  const tokens = { 'tok-u1': 'u1' };
  const auth = {
    async verifyIdToken(t) { const u = usuarios[tokens[t]]; if (!u) throw new Error('x'); return { uid: u.uid, email: u.email, auth_time: 1000, ...u.claims }; },
    async getUserByEmail(e) { const u = Object.values(usuarios).find((x) => x.email === e); if (!u) throw new Error('nao'); return u; },
    async updateUser(uid, d) { usuarios[uid].senha = d.password; },
    async revokeRefreshTokens(uid) { usuarios[uid].revogado++; },
    async setCustomUserClaims(uid, c) { usuarios[uid].claims = { ...usuarios[uid].claims, ...c }; },
  };
  const dirLogs = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-'));
  const relogio = { t: Date.UTC(2026, 9, 20, 12, 0, 0) };
  const app = criarApp({ auth, store, mailer: { async enviar(para, a, texto) { emails.push({ para, texto }); } }, chaveCripto: chave, chaveLog: 'segredo-log', origens: ['https://localhost'], dirLogs, agora: () => relogio.t, ...extra });
  return { app, store, emails, usuarios, dirLogs, relogio };
}
async function subir(app) {
  const srv = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const chamar = async (rota, corpo, { token, metodo, origem } = {}) => {
    const r = await fetch(base + rota, { method: metodo || (corpo === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(origem ? { Origin: origem } : {}) }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    return { status: r.status, corpo: await r.json().catch(() => ({})) };
  };
  return { chamar, fechar: () => srv.close() };
}

test('criptografia AES-GCM: ida e volta, e adulteração é detectada', () => {
  const blob = cifrar('segredo', chave);
  assert.equal(decifrar(blob, chave), 'segredo');
  const partes = blob.split(':'); partes[3] = Buffer.from('outro').toString('base64');
  assert.throws(() => decifrar(partes.join(':'), chave));
});

test('política de senha e sanitização', () => {
  assert.equal(avaliarSenha('abc').ok, false);
  assert.equal(avaliarSenha('Abcdef1!').ok, true);
  assert.equal(avaliarSenha('abcdefg1!').ok, false);
  assert.equal(limpar('<script>alert(1)</script>\u0000 ok'), 'scriptalert(1)/script ok');
});

test('bloqueio de login: 5 falhas bloqueiam, depois de 15 min libera', async () => {
  const m = montar(); const { chamar, fechar } = await subir(m.app);
  try {
    for (let i = 1; i <= 4; i++) { const r = await chamar('/api/seg/falha-login', { email: 'ana@teste.com' }); assert.equal(r.corpo.bloqueado, false); assert.equal(r.corpo.restantes, 5 - i); }
    assert.equal((await chamar('/api/seg/falha-login', { email: 'ana@teste.com' })).corpo.bloqueado, true);
    assert.equal((await chamar('/api/seg/pode-entrar', { email: 'ANA@teste.com' })).corpo.bloqueado, true);
    m.relogio.t += 16 * 60_000;
    assert.equal((await chamar('/api/seg/pode-entrar', { email: 'ana@teste.com' })).corpo.bloqueado, false);
  } finally { fechar(); }
});

test('OTP: não revela se o e-mail existe, vale uma vez, expira, limita tentativas e exige senha forte', async () => {
  const m = montar(); const { chamar, fechar } = await subir(m.app);
  try {
    const a = await chamar('/api/otp/solicitar', { email: 'nao@existe.com' });
    const b = await chamar('/api/otp/solicitar', { email: 'ana@teste.com' });
    assert.deepEqual(a.corpo, b.corpo);
    assert.equal(m.emails.length, 1); assert.equal(m.emails[0].para, 'ana@teste.com');
    const codigo = /(\d{6})/.exec(m.emails[0].texto)[1];
    const salvo = await m.store.get('otp', crypto.createHash('sha256').update('ana@teste.com').digest('hex'));
    assert.ok(salvo.hash.startsWith('$2'), 'OTP guardado com bcrypt'); assert.ok(!JSON.stringify(salvo).includes(codigo));
    // errado
    assert.equal((await chamar('/api/otp/redefinir', { email: 'ana@teste.com', codigo: codigo === '000000' ? '111111' : '000000', novaSenha: 'Nova#1234' })).status, 400);
    // senha fraca não consome o código
    assert.equal((await chamar('/api/otp/redefinir', { email: 'ana@teste.com', codigo, novaSenha: 'fraca' })).status, 400);
    const ok = await chamar('/api/otp/redefinir', { email: 'ana@teste.com', codigo, novaSenha: 'Nova#1234' });
    assert.equal(ok.status, 200); assert.equal(m.usuarios.u1.senha, 'Nova#1234'); assert.equal(m.usuarios.u1.revogado, 1);
    assert.equal((await chamar('/api/otp/redefinir', { email: 'ana@teste.com', codigo, novaSenha: 'Outra#1234' })).status, 400, 'uso único');
  } finally { fechar(); }
});

test('OTP expira e esgota tentativas', async () => {
  const m = montar(); const { chamar, fechar } = await subir(m.app);
  try {
    await chamar('/api/otp/solicitar', { email: 'ana@teste.com' });
    const codigo = /(\d{6})/.exec(m.emails[0].texto)[1];
    m.relogio.t += 11 * 60_000;
    assert.equal((await chamar('/api/otp/redefinir', { email: 'ana@teste.com', codigo, novaSenha: 'Nova#1234' })).status, 400);
    m.relogio.t += 61_000;
    await chamar('/api/otp/solicitar', { email: 'ana@teste.com' });
    const c2 = /(\d{6})/.exec(m.emails[1].texto)[1];
    const errado = c2 === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await chamar('/api/otp/redefinir', { email: 'ana@teste.com', codigo: errado, novaSenha: 'Nova#1234' });
    assert.equal((await chamar('/api/otp/redefinir', { email: 'ana@teste.com', codigo: c2, novaSenha: 'Nova#1234' })).status, 400, 'depois de 5 erros nem o código certo vale');
  } finally { fechar(); }
});

test('código único de recuperação: gerado uma vez, guardado só como hash, redefine a senha e morre após o uso', async () => {
  const m = montar(); const { chamar, fechar } = await subir(m.app);
  try {
    assert.equal((await chamar('/api/recuperacao/status', undefined)).status, 401);
    const g = await chamar('/api/recuperacao/gerar', {}, { token: 'tok-u1' });
    assert.equal(g.status, 200); assert.match(g.corpo.codigo, /^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
    const doc = await m.store.get('codigoRec', 'u1');
    assert.ok(doc.hash.startsWith('$2') && !JSON.stringify(doc).includes(g.corpo.codigo.replace(/-/g, '')), 'só o hash é guardado');
    assert.equal((await chamar('/api/recuperacao/status', undefined, { token: 'tok-u1' })).corpo.temCodigo, true);
    // trocar o código exige login recente (auth_time antigo = 1000 s)
    assert.equal((await chamar('/api/recuperacao/gerar', {}, { token: 'tok-u1' })).status, 403);
    // erros são genéricos: e-mail inexistente e código errado dão a mesma resposta
    const a = await chamar('/api/recuperacao/redefinir', { email: 'nao@existe.com', codigo: g.corpo.codigo, novaSenha: 'Nova#1234' });
    const b = await chamar('/api/recuperacao/redefinir', { email: 'ana@teste.com', codigo: 'AAAA-BBBB-CCCC-DDDD', novaSenha: 'Nova#1234' });
    assert.equal(a.status, 400); assert.deepEqual(a.corpo, b.corpo);
    // senha fraca não gasta o código
    assert.equal((await chamar('/api/recuperacao/redefinir', { email: 'ana@teste.com', codigo: g.corpo.codigo, novaSenha: 'fraca' })).status, 400);
    // certo (aceita minúsculas e sem hífen)
    const ok = await chamar('/api/recuperacao/redefinir', { email: 'ANA@teste.com', codigo: g.corpo.codigo.toLowerCase().replace(/-/g, ''), novaSenha: 'Nova#1234' });
    assert.equal(ok.status, 200); assert.equal(m.usuarios.u1.senha, 'Nova#1234'); assert.equal(m.usuarios.u1.revogado, 1);
    assert.notEqual(ok.corpo.novoCodigo, g.corpo.codigo);
    // o código usado não vale mais; o novo vale
    assert.equal((await chamar('/api/recuperacao/redefinir', { email: 'ana@teste.com', codigo: g.corpo.codigo, novaSenha: 'Outra#1234' })).status, 400);
    assert.equal((await chamar('/api/recuperacao/redefinir', { email: 'ana@teste.com', codigo: ok.corpo.novoCodigo, novaSenha: 'Outra#1234' })).status, 200);
    // com login recente dá para trocar
    m.usuarios.u1.claims.auth_time = Math.floor(m.relogio.t / 1000) - 60;
    assert.equal((await chamar('/api/recuperacao/gerar', {}, { token: 'tok-u1' })).status, 200);
  } finally { fechar(); }
});

test('código de recuperação: 5 erros bloqueiam, até o código certo é recusado durante o bloqueio', async () => {
  const m = montar(); const { chamar, fechar } = await subir(m.app);
  try {
    const g = await chamar('/api/recuperacao/gerar', {}, { token: 'tok-u1' });
    for (let i = 0; i < 5; i++) await chamar('/api/recuperacao/redefinir', { email: 'ana@teste.com', codigo: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', novaSenha: 'Nova#1234' });
    assert.equal((await chamar('/api/recuperacao/redefinir', { email: 'ana@teste.com', codigo: g.corpo.codigo, novaSenha: 'Nova#1234' })).status, 429);
    m.relogio.t += 16 * 60_000;
    assert.equal((await chamar('/api/recuperacao/redefinir', { email: 'ana@teste.com', codigo: g.corpo.codigo, novaSenha: 'Nova#1234' })).status, 200);
  } finally { fechar(); }
});

test('hardening: origem não autorizada, corpo inválido e erro sem detalhes internos', async () => {
  const m = montar(); const { chamar, fechar } = await subir(m.app);
  try {
    assert.equal((await chamar('/api/seg/pode-entrar', { email: 'a@b.com' }, { origem: 'https://malicioso.com' })).status, 403);
    assert.equal((await chamar('/api/seg/pode-entrar', { email: 'a@b.com' }, { origem: 'https://localhost' })).status, 200);
    assert.equal((await chamar('/api/seg/pode-entrar', { email: 'nao-e-email', extra: 1 })).status, 400);
    assert.equal((await chamar('/api/auditoria', { evento: 'apagar_tudo' }, { token: 'tok-u1' })).status, 400);
  } finally { fechar(); }
});

test('rate limit por IP responde 429', async () => {
  const m = montar(); const { chamar, fechar } = await subir(m.app);
  try {
    let ultimo = 0;
    for (let i = 0; i < 8; i++) ultimo = (await chamar('/api/otp/solicitar', { email: `x${i}@teste.com` })).status;
    assert.equal(ultimo, 429);
  } finally { fechar(); }
});

test('auditoria: encadeada por hash, sem e-mail em texto puro', async () => {
  const m = montar(); const { chamar, fechar } = await subir(m.app);
  try {
    await chamar('/api/seg/falha-login', { email: 'ana@teste.com' });
    await chamar('/api/seg/sucesso-login', {}, { token: 'tok-u1' });
    const regs = await m.store.list('auditoria');
    assert.equal(regs.length, 2); assert.equal(regs[1].anterior, regs[0].hash);
    assert.ok(!JSON.stringify(regs).includes('ana@teste.com'));
    const arq = fs.readdirSync(m.dirLogs)[0];
    assert.equal(fs.readFileSync(path.join(m.dirLogs, arq), 'utf8').trim().split('\n').length, 2);
  } finally { fechar(); }
});

test('backup: gera arquivo criptografado, legível só com a chave, e apaga cópias antigas', async () => {
  const dados = { clientes: [{ id: 'c1', d: { nome: 'Ana' } }] };
  const db = { collection: (c) => ({ get: async () => ({ docs: (dados[c] || []).map((x) => ({ id: x.id, data: () => x.d, ref: { collection: () => ({ get: async () => ({ docs: [] }) }) } })) }) }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const velho = path.join(dir, 'backup-200001010000.json.gz.enc'); fs.writeFileSync(velho, 'x'); fs.utimesSync(velho, new Date(2000, 0, 1), new Date(2000, 0, 1));
  const f = await fazerBackup({ db, dir, chave, retencaoDias: 14 });
  assert.ok(!fs.readFileSync(f, 'utf8').includes('Ana'), 'nada legível no arquivo');
  assert.equal(lerBackup(f, chave).dados.clientes[0].dados.nome, 'Ana');
  assert.throws(() => lerBackup(f, crypto.randomBytes(32)));
  assert.ok(!fs.existsSync(velho), 'cópia antiga removida');
});
