/* =====================================================================
   BarbTech — seguranca.js
   Parte de segurança que roda no aparelho: política de senha, sanitização, bloqueio local de tentativas,
   expiração por inatividade e cliente do serviço de segurança (OTP, código de recuperação, auditoria).
   O serviço backend-seguranca é opcional (OTP por e-mail, bloqueio entre aparelhos, auditoria); o código de recuperação roda só no app (recuperacao.js).
   ===================================================================== */
import { segurancaConfig } from './seguranca-config.js';

export const cfg = segurancaConfig;
export const temServico = () => /^https?:\/\//.test(cfg.url || '');

/* ---------- política de senha ---------- */
export const REGRAS_SENHA = [
  { id: 'tamanho',   txt: 'Pelo menos 8 caracteres',        ok: s => s.length >= 8 },
  { id: 'maiuscula', txt: 'Uma letra maiúscula (A-Z)',      ok: s => /[A-ZÀ-Ý]/.test(s) },
  { id: 'minuscula', txt: 'Uma letra minúscula (a-z)',      ok: s => /[a-zß-ÿ]/.test(s) },
  { id: 'numero',    txt: 'Um número (0-9)',                ok: s => /\d/.test(s) },
  { id: 'especial',  txt: 'Um caractere especial (!@#$…)',  ok: s => /[^A-Za-zÀ-ÿ0-9\s]/.test(s) }
];
export function avaliarSenha(s){
  s = String(s || '');
  const regras = REGRAS_SENHA.map(r => ({ id: r.id, txt: r.txt, ok: r.ok(s) }));
  const n = regras.filter(r => r.ok).length;
  return { ok: n === regras.length && s.length <= 128, regras, forca: n };
}
const ROTULO_FORCA = ['Muito fraca', 'Muito fraca', 'Fraca', 'Média', 'Boa', 'Forte'];
// desenha a lista de requisitos e uma barra de força; atualiza a cada tecla
export function ligarValidadorSenha(inputId, boxId, repetirId){
  const inp = document.getElementById(inputId), box = document.getElementById(boxId);
  if(!inp || !box) return;
  const rep = repetirId ? document.getElementById(repetirId) : null;
  const pintar = () => {
    const a = avaliarSenha(inp.value);
    box.innerHTML = `<div class="pw-bar"><i class="f${a.forca}" style="width:${a.forca * 20}%"></i></div>
      <div class="pw-lbl">${inp.value ? ROTULO_FORCA[a.forca] : 'Crie uma senha forte'}${rep && rep.value ? (rep.value === inp.value ? ' · senhas iguais ✓' : ' · senhas diferentes') : ''}</div>
      <ul class="pw-list">${a.regras.map(r => `<li class="${r.ok ? 'ok' : ''}"><b>${r.ok ? '✓' : '○'}</b> ${r.txt}</li>`).join('')}</ul>`;
  };
  inp.addEventListener('input', pintar); if(rep) rep.addEventListener('input', pintar);
  pintar();
  return pintar;
}

/* ---------- sanitização ---------- */
// Texto livre que vai para o banco: tira caracteres de controle e os sinais < >, junta espaços e limita o tamanho.
// (Na tela o app ainda escapa tudo com esc(); isso é a segunda camada. Firestore não usa SQL, então não há SQL Injection a tratar.)
export const limpar = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
export const limparObj = (o, max = 200) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? limpar(v, max) : v]));
export const emailValido = e => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e) && e.length <= 120;

/* ---------- CPF, CNPJ e telefone ---------- */
const dig = v => String(v || '').replace(/\D/g, '');
export const mascaraCpf = v => { const d = dig(v).slice(0, 11); return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2'); };
export const mascaraCnpj = v => { const d = dig(v).slice(0, 14); return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2'); };
export const mascaraTel = v => { const d = dig(v).slice(0, 11); return d.length > 10 ? d.replace(/^(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3') : d.length > 6 ? d.replace(/^(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3') : d.length > 2 ? d.replace(/^(\d{2})(\d+)/, '($1) $2') : d; };
// dígitos verificadores (módulo 11); recusa sequências repetidas como 111.111.111-11
function digitos(base, pesos){ let s = 0; for(let i = 0; i < pesos.length; i++) s += +base[i] * pesos[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; }
export function cpfValido(v){
  const d = dig(v); if(d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const p1 = digitos(d, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return p1 === +d[9] && digitos(d, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === +d[10];
}
export function cnpjValido(v){
  const d = dig(v); if(d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const p1 = digitos(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return p1 === +d[12] && digitos(d, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === +d[13];
}
export const telValido = v => { const d = dig(v); return (d.length === 10 || d.length === 11) && !/^(\d)\1+$/.test(d) && +d.slice(0, 2) >= 11; };

/* ---------- bloqueio local por tentativas (complementa o do servidor) ---------- */
const MAX_FALHAS = 5, BLOQ_MIN = [5, 15, 60];
const lerLk = () => { try{ return JSON.parse(localStorage.getItem('bt_lk') || '{}'); }catch(e){ return {}; } };
const gravarLk = o => { try{ localStorage.setItem('bt_lk', JSON.stringify(o)); }catch(e){} };
const kEmail = e => String(e || '').trim().toLowerCase();
export function bloqueioLocal(email, agora = Date.now()){
  const r = lerLk()[kEmail(email)];
  if(r && r.ate > agora) return { bloqueado: true, restanteSeg: Math.ceil((r.ate - agora) / 1000) };
  return { bloqueado: false, restanteSeg: 0 };
}
export function falhaLocal(email, agora = Date.now()){
  const t = lerLk(), k = kEmail(email), r = t[k] || { f: 0, n: 0, ate: 0 };
  if(r.ate > agora) return { bloqueado: true, restantes: 0, restanteSeg: Math.ceil((r.ate - agora) / 1000) };
  r.f += 1;
  let bloqueado = false;
  if(r.f >= MAX_FALHAS){ r.f = 0; r.ate = agora + BLOQ_MIN[Math.min(r.n, BLOQ_MIN.length - 1)] * 60000; r.n += 1; bloqueado = true; }
  t[k] = r; gravarLk(t);
  return { bloqueado, restantes: Math.max(0, MAX_FALHAS - r.f), restanteSeg: bloqueado ? Math.ceil((r.ate - agora) / 1000) : 0 };
}
export function sucessoLocal(email){ const t = lerLk(); delete t[kEmail(email)]; gravarLk(t); }
export const fmtEspera = seg => seg >= 60 ? `${Math.ceil(seg / 60)} min` : `${seg} s`;

/* ---------- expiração por inatividade ---------- */
let idT = null, ultimo = Date.now(), avisou = false, opts = null;
const EVT = ['pointerdown', 'keydown', 'touchstart', 'scroll', 'wheel'];
const marcar = () => { ultimo = Date.now(); avisou = false; try{ localStorage.setItem('bt_ult', String(ultimo)); }catch(e){} };
function checar(){
  if(!opts) return;
  const ocioso = Date.now() - ultimo, lim = opts.minutos * 60000;
  if(ocioso >= lim){ const f = opts.onExpira; pararInatividade(); f(); }
  else if(!avisou && ocioso >= lim - 60000){ avisou = true; opts.onAviso && opts.onAviso(); }
}
export function iniciarInatividade({ minutos = 15, onAviso, onExpira }){
  pararInatividade();
  opts = { minutos, onAviso, onExpira };
  marcar();
  EVT.forEach(e => window.addEventListener(e, marcar, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', checar);
  idT = setInterval(checar, 15000);
}
export function pararInatividade(){
  EVT.forEach(e => window.removeEventListener(e, marcar, { capture: true }));
  document.removeEventListener('visibilitychange', checar);
  clearInterval(idT); idT = null; opts = null;
}
// ao reabrir o app com a sessão salva: já passou do limite sem uso?
export function inatividadeExpirada(minutos = cfg.inatividadeMin){
  try{ const u = Number(localStorage.getItem('bt_ult') || 0); return u > 0 && Date.now() - u > minutos * 60000; }catch(e){ return false; }
}

/* ---------- cliente do serviço de segurança ---------- */
export async function seg(caminho, corpo, token){
  if(!temServico()) return { ok: false, indisponivel: true, status: 0, dados: {} };
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 9000);
  try{
    const r = await fetch(cfg.url.replace(/\/$/, '') + caminho, {
      method: corpo === undefined ? 'GET' : 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo)
    });
    const dados = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, dados };
  }catch(e){ return { ok: false, rede: true, status: 0, dados: {} }; }
  finally{ clearTimeout(t); }
}
