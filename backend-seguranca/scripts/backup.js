// Backup automático: lê as coleções do Firestore, compacta (gzip), criptografa (AES-256-GCM) e apaga cópias antigas.
// Uso manual:  node scripts/backup.js      (usa o .env)    |    Restaurar:  node scripts/backup.js --ler arquivo.enc
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { cifrar, decifrar } from '../src/cripto.js';

export const COLECOES = ['clientes', 'profissionais', 'agendas', 'barbearias', 'servicos', 'agendamentos', 'horariosOcupados', 'promocoes', 'notificacoes'];
const SUB = { profissionais: ['privado'] };   // subcoleções que também entram (os banners ficam de fora: são pesados e recriáveis)

export async function fazerBackup({ db, dir, chave, retencaoDias = 14, agora = new Date(), colecoes = COLECOES }) {
  const dados = {};
  for (const c of colecoes) {
    const snap = await db.collection(c).get();
    dados[c] = [];
    for (const d of snap.docs) {
      const item = { id: d.id, dados: d.data(), sub: {} };
      for (const s of SUB[c] || []) item.sub[s] = (await d.ref.collection(s).get()).docs.map((x) => ({ id: x.id, dados: x.data() }));
      dados[c].push(item);
    }
  }
  const bruto = zlib.gzipSync(Buffer.from(JSON.stringify({ geradoEm: agora.toISOString(), dados })));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const nome = `backup-${agora.toISOString().replace(/[-:T]/g, '').slice(0, 12)}.json.gz.enc`;
  const destino = path.join(dir, nome);
  fs.writeFileSync(destino, cifrar(bruto, chave), { mode: 0o600 });
  // retenção
  const limite = agora.getTime() - retencaoDias * 86400000;
  for (const f of fs.readdirSync(dir)) {
    if (!/^backup-.*\.enc$/.test(f)) continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).mtimeMs < limite) fs.unlinkSync(p);
  }
  return destino;
}

export function lerBackup(arquivo, chave) {
  const bruto = decifrar(fs.readFileSync(arquivo, 'utf8'), chave, true);
  return JSON.parse(zlib.gunzipSync(bruto).toString('utf8'));
}

// agenda diária no horário local do servidor (BACKUP_HORA, padrão 3h)
export function agendarBackup(fn, hora = 3) {
  let ultimoDia = '';
  const t = setInterval(() => {
    const d = new Date();
    const dia = d.toISOString().slice(0, 10);
    if (d.getHours() === hora && dia !== ultimoDia) { ultimoDia = dia; fn().catch((e) => console.error('[backup] falhou', e?.code || e?.name)); }
  }, 10 * 60_000);
  t.unref();
  return t;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await import('dotenv/config');
  const { chaveDe } = await import('../src/cripto.js');
  const chave = chaveDe(process.env.CHAVE_CRIPTO);
  if (process.argv[2] === '--ler') {
    const r = lerBackup(process.argv[3], chave);
    console.log(Object.entries(r.dados).map(([c, l]) => `${c}: ${l.length} documentos`).join('\n'));
  } else {
    const { default: admin } = await import('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT, 'utf8'))) });
    console.log('Backup gravado em', await fazerBackup({ db: admin.firestore(), dir: process.env.DIR_BACKUP || './backups', chave, retencaoDias: Number(process.env.BACKUP_RETENCAO_DIAS || 14) }));
  }
}
