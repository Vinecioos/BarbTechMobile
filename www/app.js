/* =====================================================================
   BarbTech — app.js
   Firebase Authentication + Cloud Firestore (SDK web, carregado do CDN do Google).

   Coleções (ver firebase/firestore_estrutura.md):
     clientes/{uid}                      perfil privado do cliente
     profissionais/{uid}                 perfil público do profissional
     profissionais/{uid}/privado/dados   CPF, CNPJ e endereço do profissional
     agendas/{uid}                       agenda 1:1 com o profissional
     barbearias/{id}   servicos/{id}   agendamentos/{id}
     horariosOcupados/{profId_AAAAMMDD_HHmm}   impede dois clientes no mesmo horário
     notificacoes/{id}
     profissionais/{uid}/midia/banner  e  clientes/{uid}/midia/banner   (imagem do banner, comprimida)
     dispositivos/{uid_hash}           token do celular para notificação push
     promocoes/{id}                    destaques do profissional (novidades e promoções)

   Assistente virtual (chatbot): chatbot.js, com backend em backend-chatbot/.
   ===================================================================== */

import { criarChatbot } from './chatbot.js';
import * as SG from './seguranca.js';
import * as RC from './recuperacao.js';

const FIREBASE_VERSION = '10.14.1';
const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;

const SLOT_MIN = 30;          // grade de horários (minutos). Um serviço ocupa ceil(duração/30) blocos.
const TAXA_DOMICILIO = 22;    // R$ cobrados no atendimento em casa
const JANELA_MESES = 2;       // quantos meses à frente o cliente pode agendar

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
const DIAS = ['dom','seg','ter','qua','qui','sex','sab'];
const DIAS_ABREV = ['dom','seg','ter','qua','qui','sex','sáb'];
const DIAS_NOME = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
const ORDEM_SEMANA = [1,2,3,4,5,6,0];
const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const MESES_ABREV = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

const HORARIOS_PADRAO = {
  seg:{aberto:true,  inicio:'09:00', fim:'19:00'},
  ter:{aberto:true,  inicio:'09:00', fim:'19:00'},
  qua:{aberto:true,  inicio:'09:00', fim:'19:00'},
  qui:{aberto:true,  inicio:'09:00', fim:'21:00'},
  sex:{aberto:true,  inicio:'09:00', fim:'21:00'},
  sab:{aberto:true,  inicio:'08:00', fim:'18:00'},
  dom:{aberto:false, inicio:'09:00', fim:'18:00'}
};

// atendimento em casa: começa tudo fechado; o profissional escolhe dias e horários no painel
const HORARIOS_DOM_PADRAO = Object.fromEntries(['seg','ter','qua','qui','sex','sab','dom'].map(k => [k, { aberto:false, inicio:'09:00', fim:'18:00' }]));

const CLIENTE_VAZIO = {
  nome:'', telefone:'', estado:'', cpf:'', cnpj:'',
  logradouroResidencia:'', bairroResidencia:'', cepResi:'', complementoResidencia:'',
  cidadeResidencia:'', condicao:'', perfilCompleto:false, fotoUrl:'', lat:null, lng:null
};

const STATUS = {
  PENDENTE:  {t:'aguardando', c:'wait'},
  CONFIRMADO:{t:'confirmado', c:'ok'},
  REMARCADO: {t:'remarcado',  c:'wait'},
  CANCELADO: {t:'cancelado',  c:'bad'},
  CONCLUIDO: {t:'concluído',  c:''}
};

const ICON_CAL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>';
const ICON_BELL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';

/* ---------------------------------------------------------------------
   utilidades
   --------------------------------------------------------------------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const toMin = t => { const [h,m] = t.split(':').map(Number); return h*60 + m; };
const fromMin = n => `${pad(Math.floor(n/60))}:${pad(n%60)}`;
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const inic = n => (String(n||'').trim().split(/\s+/).filter(Boolean).slice(0,2).map(p=>p[0]).join('').toUpperCase()) || '?';
const primeiroNome = n => String(n||'').trim().split(/\s+/)[0] || 'Profissional';
const dinheiro = v => 'R$ ' + (Number.isInteger(+v) ? String(+v) : (+v).toFixed(2).replace('.', ','));
const dataCurta = s => { const d = parseYmd(s); return `${DIAS_ABREV[d.getDay()]}, ${d.getDate()} ${MESES_ABREV[d.getMonth()]}`; };
const agoraStr = (offMin = 0) => { const d = new Date(Date.now() + offMin*60000); return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const porDataHora = (a,b) => `${a.data} ${a.horario}`.localeCompare(`${b.data} ${b.horario}`);
const val = id => SG.limpar($(id).value, 300);   // (veja também aplicarLimites)
// confere CPF, CNPJ e telefone preenchidos; devolve o texto do erro ou '' se estiver tudo certo
function erroDocs({ cpf, cnpj, telefone }){
  if(telefone !== undefined && !SG.telValido(telefone)) return 'Telefone inválido. Use DDD + número, ex.: (11) 91234-5678.';
  if(!cpf && !cnpj) return 'Informe o CPF ou o CNPJ.';
  if(cpf && !SG.cpfValido(cpf)) return 'CPF inválido. Confira os números.';
  if(cnpj && !SG.cnpjValido(cnpj)) return 'CNPJ inválido. Confira os números.';
  return '';
}
// limites de tamanho para todos os campos + máscaras de CPF, CNPJ e telefone
const LIMITES = [[/(^|-)senha2?$/, 128], [/email$/, 120], [/-tel$/, 15], [/-cpf$/, 14], [/-cnpj$/, 18], [/-cep$/, 9], [/-cond$/, 200], [/-comp$/, 60], [/-bairro$/, 60], [/-cidade$/, 60], [/-rua$/, 100], [/-nome$/, 80], [/^busca$/, 60], [/-(taxa|preco|desconto)$/, 10], [/-dur$/, 4]];
function aplicarLimites(){
  document.querySelectorAll('input:not([type=checkbox]):not([type=file]):not([type=range]):not([type=date]), textarea').forEach(el => {
    if(el.id === 'expOut' || el.hasAttribute('maxlength')) return;
    const l = LIMITES.find(([re]) => re.test(el.id));
    el.setAttribute('maxlength', l ? l[1] : (el.tagName === 'TEXTAREA' ? 500 : 120));
  });
  const mask = (suf, fn) => document.querySelectorAll(`input[id$="-${suf}"]`).forEach(el => el.addEventListener('input', () => { const m = fn(el.value); if(m !== el.value) el.value = m; }));
  mask('cpf', SG.mascaraCpf); mask('cnpj', SG.mascaraCnpj); mask('tel', SG.mascaraTel);
  const dur = $('sv-dur'); if(dur){ dur.max = 600; }
}   // toda entrada de texto passa pela sanitização (sem < >, sem caracteres de controle)

/* ---------------------------------------------------------------------
   foto de perfil e banner: a imagem é reduzida no aparelho e guardada no próprio Firestore
   (sem Firebase Storage, que exige plano pago). Foto ~256 px, banner ~960x320 px.
   --------------------------------------------------------------------- */
const FOTO_MAX = 45000, BANNER_MAX = 220000;          // tamanho máximo do texto base64
function lerImagem(file){
  return new Promise((ok, err) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); ok(im); };
    im.onerror = () => { URL.revokeObjectURL(url); err(new Error('Não consegui abrir essa imagem.')); };
    im.src = url;
  });
}
async function reduzirImagem(file, w, h, maxChars){
  const im = await lerImagem(file);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const r = Math.max(w / im.width, h / im.height), dw = im.width * r, dh = im.height * r;
  x.fillStyle = '#15130f'; x.fillRect(0, 0, w, h);
  x.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh);
  for(let q = 0.85; q >= 0.35; q -= 0.1){
    const u = c.toDataURL('image/jpeg', q);
    if(u.length <= maxChars) return u;
  }
  throw new Error('Essa imagem ficou grande demais. Escolha outra.');
}

/* ---------------------------------------------------------------------
   Ajuste de foto/banner: o usuário arrasta e dá zoom; "Preencher" corta nas bordas, "Inteira" mostra a imagem toda
   --------------------------------------------------------------------- */
function ajustarImagem(file, w, h, maxChars, titulo){
  return new Promise(async (fim, falha) => {
    let im; try{ im = await lerImagem(file); }catch(e){ return falha(e); }
    const box = $('crop'), cv = $('cropCv'), zoom = $('cropZoom'), x = cv.getContext('2d');
    cv.width = w; cv.height = h; cv.style.aspectRatio = `${w} / ${h}`;
    $('cropTit').textContent = titulo;
    const fit = Math.min(w / im.width, h / im.height), cover = Math.max(w / im.width, h / im.height);
    let esc_ = cover, x0 = 0, y0 = 0;
    const lim = () => {
      const dw = im.width * esc_, dh = im.height * esc_;
      x0 = dw >= w ? Math.min(0, Math.max(w - dw, x0)) : Math.min(w - dw, Math.max(0, x0));
      y0 = dh >= h ? Math.min(0, Math.max(h - dh, y0)) : Math.min(h - dh, Math.max(0, y0));
    };
    const centrar = () => { x0 = (w - im.width * esc_) / 2; y0 = (h - im.height * esc_) / 2; };
    const desenhar = () => {
      lim(); x.fillStyle = '#15130f'; x.fillRect(0, 0, w, h);
      x.drawImage(im, x0, y0, im.width * esc_, im.height * esc_);
    };
    const aplicar = v => { const cx = (w / 2 - x0) / esc_, cy = (h / 2 - y0) / esc_; esc_ = v; x0 = w / 2 - cx * esc_; y0 = h / 2 - cy * esc_; zoom.value = v; desenhar(); };
    zoom.min = fit; zoom.max = cover * 4; zoom.step = (cover * 4 - fit) / 200 || 0.001;
    centrar(); zoom.value = esc_; desenhar();
    zoom.oninput = () => aplicar(+zoom.value);
    $('cropFit').onclick = () => { esc_ = fit; zoom.value = fit; centrar(); desenhar(); };
    $('cropFill').onclick = () => { esc_ = cover; zoom.value = cover; centrar(); desenhar(); };
    let ult = null;
    cv.onpointerdown = e => { ult = e; try{ cv.setPointerCapture(e.pointerId); }catch(_){} };
    cv.onpointermove = e => {
      if(!ult) return;
      const k = w / cv.getBoundingClientRect().width;
      x0 += (e.clientX - ult.clientX) * k; y0 += (e.clientY - ult.clientY) * k; ult = e; desenhar();
    };
    cv.onpointerup = cv.onpointercancel = () => { ult = null; };
    cv.onwheel = e => { e.preventDefault(); aplicar(Math.min(+zoom.max, Math.max(+zoom.min, esc_ * (e.deltaY < 0 ? 1.08 : 0.92)))); };
    const sair = () => { box.hidden = true; zoom.oninput = cv.onpointerdown = cv.onpointermove = cv.onwheel = null; };
    $('cropNo').onclick = () => { sair(); fim(null); };
    $('cropOk').onclick = () => {
      try{
        for(let q = 0.88; q >= 0.35; q -= 0.1){
          const u = cv.toDataURL('image/jpeg', q);
          if(u.length <= maxChars){ sair(); return fim(u); }
        }
        toast('Imagem pesada demais. Reduza o zoom ou escolha outra.');
      }catch(e){ sair(); falha(e); }
    };
    box.hidden = false;
  });
}
const imgOk = u => typeof u === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(u);
// preenche um elemento com a foto (ou as iniciais)
function setAvatar(el, p){
  if(!el) return;
  if(p && imgOk(p.fotoUrl)){ el.classList.add('has-img'); el.innerHTML = `<img alt="" src="${p.fotoUrl}">`; }
  else{ el.classList.remove('has-img'); el.textContent = inic(p && p.nome); }
}
function setCover(el, url){
  if(!el) return;
  const ok = imgOk(url);
  el.classList.toggle('has-cover', ok);
  el.style.backgroundImage = ok ? `url("${url}")` : '';
}
// html de uma foto em lista
const picHtml = (p, extra = '') => imgOk(p.fotoUrl)
  ? `<div class="pic ph ph-img ${extra}"><img alt="" src="${p.fotoUrl}"></div>`
  : `<div class="pic ph ph-face initials ${extra}">${esc(inic(p.nome))}</div>`;

/* ---------------------------------------------------------------------
   localização pelo CEP: CEP → latitude/longitude → distância (Haversine)
   Tenta BrasilAPI, depois ViaCEP + OpenStreetMap (Nominatim). Resultado fica em cache no aparelho.
   --------------------------------------------------------------------- */
const soDigitos = v => String(v || '').replace(/\D/g, '');
const cepValido = v => soDigitos(v).length === 8;
const numOk = n => typeof n === 'number' && Number.isFinite(n);
async function getJson(url, ms = 7000){
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try{
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if(!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  }finally{ clearTimeout(t); }
}
async function nominatim(params){
  const q = new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'br', ...params });
  const j = await getJson('https://nominatim.openstreetmap.org/search?' + q);
  const r = Array.isArray(j) && j[0];
  return r ? { lat: parseFloat(r.lat), lng: parseFloat(r.lon) } : null;
}
/* Consulta o CEP nas bases públicas (BrasilAPI, depois ViaCEP).
   Devolve { ok:true, dados:{ rua, bairro, cidade, uf, pos } }
        ou { ok:false, motivo:'formato' | 'inexistente' | 'rede' }.  Nunca lança erro. */
const CEPS = new Map();
const semCache = j => { try{ return JSON.parse(j); }catch(e){ return null; } };
async function consultarCep(cep){
  const c = soDigitos(cep);
  if(c.length !== 8) return { ok: false, motivo: 'formato' };
  if(CEPS.has(c)) return { ok: true, dados: CEPS.get(c) };
  const guardado = semCache(localStorage.getItem('bt_cep_' + c) || 'null');
  if(guardado && guardado.cidade){ CEPS.set(c, guardado); return { ok: true, dados: guardado }; }
  let dados = null, naoExiste = 0, falhou = 0;
  try{
    const j = await getJson('https://brasilapi.com.br/api/cep/v2/' + c);
    if(j && j.city){
      const co = j.location && j.location.coordinates, la = co && parseFloat(co.latitude), lo = co && parseFloat(co.longitude);
      dados = { rua: j.street || '', bairro: j.neighborhood || '', cidade: j.city, uf: j.state || '', pos: (numOk(la) && numOk(lo)) ? { lat: la, lng: lo } : null };
    }else naoExiste++;
  }catch(e){ /^Error: http (400|404)/.test(String(e)) ? naoExiste++ : falhou++; }
  if(!dados){
    try{
      const j = await getJson('https://viacep.com.br/ws/' + c + '/json/');
      if(j && !j.erro && j.localidade) dados = { rua: j.logradouro || '', bairro: j.bairro || '', cidade: j.localidade, uf: j.uf || '', pos: null };
      else naoExiste++;
    }catch(e){ falhou++; }
  }
  if(!dados) return { ok: false, motivo: (naoExiste && !falhou) || naoExiste >= 2 ? 'inexistente' : 'rede' };
  CEPS.set(c, dados);
  try{ localStorage.setItem('bt_cep_' + c, JSON.stringify(dados)); }catch(e){}
  return { ok: true, dados };
}
// confere se o CEP existe e se bate com a cidade (e o estado) informados
async function validarEndereco(cep, cidade, uf){
  const r = await consultarCep(cep);
  if(!r.ok){
    return { ok: false, erro: r.motivo === 'formato' ? 'O CEP precisa ter 8 números.'
      : r.motivo === 'inexistente' ? 'Esse CEP não existe. Confira o número.'
      : 'Não consegui confirmar o CEP agora. Verifique a internet e tente de novo.' };
  }
  const d = r.dados;
  if(!norm(cidade)) return { ok: false, erro: 'Informe a cidade.' };
  if(norm(cidade) !== norm(d.cidade)) return { ok: false, erro: `Esse CEP é de ${d.cidade}/${d.uf}, e não de ${String(cidade).trim()}. Confira o CEP ou a cidade.` };
  if(uf && d.uf && uf !== d.uf) return { ok: false, erro: `Esse CEP é do estado ${d.uf}, e você escolheu ${uf}.` };
  return { ok: true, dados: d };
}
// devolve { lat, lng } ou null (nunca lança erro)
async function geocodificarCep(cep){
  if(!consentOk('localizacao')) return null;     // sem consentimento de localização, o CEP não é convertido em posição
  const c = soDigitos(cep);
  if(c.length !== 8) return null;
  const chave = 'bt_geo_' + c;
  try{ const k = JSON.parse(localStorage.getItem(chave) || 'null'); if(k && numOk(k.lat) && numOk(k.lng)) return k; }catch(e){}
  const r = await consultarCep(c);
  if(!r.ok) return null;
  const { rua, bairro, cidade, uf } = r.dados;
  let pos = r.dados.pos;
  if(!pos && cidade){
    try{
      if(rua) pos = await nominatim({ street: rua, city: cidade, state: uf });
      if(!pos && bairro) pos = await nominatim({ q: `${bairro}, ${cidade}, ${uf}, Brasil` });
      if(!pos) pos = await nominatim({ city: cidade, state: uf });
    }catch(e){ console.warn('nominatim', e); }
  }
  if(pos && numOk(pos.lat) && numOk(pos.lng)){
    try{ localStorage.setItem(chave, JSON.stringify(pos)); }catch(e){}
    return pos;
  }
  return null;
}
const mascaraCep = v => { const d = soDigitos(v).slice(0, 8); return d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d; };
// Campos de endereço de um formulário (prefixo "me", "cp", "pr", "bb", "cc"): ao completar o CEP, consulta e preenche cidade/estado
// (e rua/bairro quando estiverem vazios), avisando na hora se o CEP não existe.
function ligarCep(pf){
  const cep = $(pf + '-cep'); if(!cep) return;
  const info = $(pf + '-cepInfo');
  const msg = (t, cls) => { if(info){ info.textContent = t; info.className = 'hint cep-info ' + (cls || ''); } };
  let seq = 0;
  const conferir = async () => {
    const meu = ++seq, c = soDigitos(cep.value);
    if(c.length < 8) return msg('');
    msg('Consultando o CEP…');
    const r = await consultarCep(c);
    if(meu !== seq) return;
    if(!r.ok) return msg(r.motivo === 'inexistente' ? 'CEP não encontrado.' : 'Não consegui consultar o CEP agora.', 'ruim');
    const d = r.dados;
    if($(pf + '-cidade')) $(pf + '-cidade').value = d.cidade;
    if($(pf + '-uf') && UFS.includes(d.uf)) $(pf + '-uf').value = d.uf;
    if(d.rua && $(pf + '-rua') && !$(pf + '-rua').value.trim()) $(pf + '-rua').value = d.rua;
    if(d.bairro && $(pf + '-bairro') && !$(pf + '-bairro').value.trim()) $(pf + '-bairro').value = d.bairro;
    msg(`✓ ${d.cidade}/${d.uf}`, 'bom');
  };
  cep.addEventListener('input', () => { const m = mascaraCep(cep.value); if(m !== cep.value) cep.value = m; conferir(); });
  cep.addEventListener('blur', conferir);
}
// o endereço do profissional é privado: na parte pública guardamos só uma posição aproximada (~1 km)
const aprox = n => Math.round(n * 100) / 100;
function kmEntre(a, b){
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLa = rad(b.lat - a.lat), dLo = rad(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const fmtKm = km => km < 1 ? 'a menos de 1 km' : 'a ~' + (km < 10 ? km.toFixed(1).replace('.', ',') : String(Math.round(km))) + ' km';
const consentOk = k => !S.consent || S.consent[k] !== false;
const posCliente = () => (S.tipo === 'cliente' && consentOk('localizacao') && S.perfil && numOk(S.perfil.lat) && numOk(S.perfil.lng)) ? { lat: S.perfil.lat, lng: S.perfil.lng } : null;
// distância (km) do cliente até o profissional, ou null se faltar CEP de algum dos dois
function kmDoPro(p){
  const me = posCliente();
  return (me && p && numOk(p.lat) && numOk(p.lng)) ? kmEntre(me, p) : null;
}
const distTxt = p => { const k = kmDoPro(p); return k == null ? '' : fmtKm(k); };

// blocos de 30 min ocupados por um agendamento → ids dos documentos em horariosOcupados
// taxa de deslocamento: cada profissional define a sua (padrão R$ 22)
const taxaDe = p => (p && Number.isFinite(+p.taxaDomicilio) && p.taxaDomicilio !== null && p.taxaDomicilio !== '' && +p.taxaDomicilio >= 0) ? +p.taxaDomicilio : TAXA_DOMICILIO;
const slotId = (pid, data, hora) => `${pid}_${data.replace(/-/g,'')}_${hora.replace(':','')}`;
const slotIds = (pid, data, hora, dur) => {
  const n = Math.ceil(dur / SLOT_MIN), ini = toMin(hora);
  return Array.from({length:n}, (_, k) => slotId(pid, data, fromMin(ini + k*SLOT_MIN)));
};
const horaDoId = id => { const t = id.slice(-4); return `${t.slice(0,2)}:${t.slice(2)}`; };
const notifId = () => `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

function geraSlots(h, dur){
  if(!h || !h.aberto || !h.inicio || !h.fim) return [];
  const out = [], fim = toMin(h.fim);
  for(let t = toMin(h.inicio); t + dur <= fim; t += SLOT_MIN) out.push(fromMin(t));
  return out;
}

// Horários de início possíveis num dia (já sem os que passaram, se for hoje).
function candidatosDoDia(horarios, dia, dur){
  const d = parseYmd(dia);
  let c = geraSlots(horarios[DIAS[d.getDay()]], dur);
  if(dia === ymd(new Date())){ const a = new Date(), min = a.getHours() * 60 + a.getMinutes(); c = c.filter(t => toMin(t) > min); }
  return c;
}
// O serviço que começa em t cabe nos blocos de 30 min que ainda estão livres?
const slotLivre = (t, dur, ocupados) => {
  for(let k = 0, n = Math.ceil(dur / SLOT_MIN); k < n; k++) if(ocupados.has(fromMin(toMin(t) + k * SLOT_MIN))) return false;
  return true;
};
const horasLivres = (horarios, dia, dur, ocupados) => candidatosDoDia(horarios, dia, dur).filter(t => slotLivre(t, dur, ocupados));

const ativo   = a => ['PENDENTE','CONFIRMADO','REMARCADO'].includes(a.status);
const proximo = a => ativo(a) && `${a.data} ${a.horario}` >= agoraStr(-60);
const futuro  = a => `${a.data} ${a.horario}` >= agoraStr();

/* ---------------------------------------------------------------------
   estado
   --------------------------------------------------------------------- */
let FB = null, auth = null, db = null;
let pintarCp = null, pintarRec = null, pintarRec0 = null;
let bot = null, CHAT_URL = '';      // assistente virtual e a URL do backend dele (chatbot-config.js)

const S = {
  tela: 's-splash', roleChoice: 'cliente',
  user: null, tipo: null, perfil: null, privado: null,
  sessaoUid: null, autenticando: false, completandoPro: false,
  pros: [], servicos: [], barbearias: {}, agendas: {}, agendasDom: {}, pubTs: 0,
  agds: [], notifs: [], unsubs: [], bannerProprio: '', banners: {}, perto: true, raio: lerRaio(), consent: null, pushOuvindo: false,
  destaque: null, soDomicilio: false, promos: [], promosPro: [], promoEdit: null, pushPronto: false,
  // agendamento em andamento
  pro: null, agendaPro: null, sel: {servicoId:null, dia:null, hora:null, dom:false},
  calRef: new Date(), ocupados: new Set(), slotReq: 0, remarcando: null, origem: 's-barbers',
  // painel do profissional
  horariosPro: {...HORARIOS_PADRAO}, horariosDom: {...HORARIOS_DOM_PADRAO}, svEditId: null, voltarPara: null, biPeriodo: 'dia'
};

/* ---------------------------------------------------------------------
   interface básica
   --------------------------------------------------------------------- */
const SEM_BARRA = ['s-splash','s-login','s-cadpro','s-cadcli','s-recup','s-codigo','s-priv'];
const SEM_BOT = ['s-splash','s-login','s-cadpro','s-cadcli','s-barber','s-recup','s-codigo','s-priv','s-seg'];   // s-barber tem a barra de confirmação no rodapé

function show(id){
  S.tela = id;
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  const semBarra = SEM_BARRA.includes(id);
  $('tabbar').hidden = semBarra || S.tipo !== 'cliente';
  $('tabbar-pro').hidden = semBarra || S.tipo !== 'pro';
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.go === id));
  const sc = document.querySelector('#' + id + ' .scroll');
  if(sc) sc.scrollTop = 0;
  if(bot) bot.visivel(S.tipo === 'cliente' && !SEM_BOT.includes(id));
  if(ENTER[id]) ENTER[id]();
}
function go(id, tipo){ S.roleChoice = tipo; show(id); }

let tId;
function toast(msg, ms = 2600){
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(tId); tId = setTimeout(() => t.classList.remove('show'), ms);
}
function sw(el){ el.classList.toggle('on'); }
function tab(btn, panel){
  btn.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
  btn.classList.add('on');
  document.querySelectorAll('#s-barber .tabpanel').forEach(p => p.classList.toggle('on', p.id === panel));
  if(S.tela === 's-barber') renderResumo();
}
const painelBarber = () => { const e = document.querySelector('#s-barber .tabpanel.on'); return e ? e.id : 'p-agenda'; };
// abre uma aba do perfil do barbeiro pelo id do painel
function irAba(panel){
  const i = ['p-svc', 'p-agenda', 'p-sobre'].indexOf(panel);
  const b = document.querySelectorAll('#s-barber .tab')[i];
  if(b) tab(b, panel);
  const sc = document.querySelector('#s-barber .scroll'); if(sc) sc.scrollTop = 0;
}
const hideBoot = () => { $('boot').hidden = true; };
const avisoCfg = msg => { const w = $('cfgWarn'); w.textContent = '⚠ ' + msg; w.hidden = false; };
const loginErro = msg => { $('loginErr').textContent = msg || ''; };

function msgErro(e){
  // O usuário só vê mensagens nossas, em português e sem detalhe técnico. O erro original vai apenas para o console (console.error nos chamadores).
  const c = (e && e.code) || '';
  const m = {
    'auth/invalid-email': 'E-mail inválido.',
    'auth/missing-password': 'Informe a senha.',
    'auth/user-not-found': 'E-mail ou senha incorretos.',
    'auth/wrong-password': 'E-mail ou senha incorretos.',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/invalid-login-credentials': 'E-mail ou senha incorretos.',
    'auth/email-already-in-use': 'Não foi possível criar a conta com esse e-mail. Se já tem cadastro, use "Entrar".',
    'auth/weak-password': 'A senha não atende aos requisitos de segurança.',
    'auth/network-request-failed': 'Sem conexão com a internet.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente de novo.',
    'auth/unverified-email': 'Confirme o seu e-mail antes de ativar a verificação em duas etapas.',
    'auth/requires-recent-login': 'Por segurança, entre de novo e tente outra vez.',
    'auth/second-factor-already-in-use': 'A verificação em duas etapas já está ativa.',
    'app/mfa-indisponivel': 'Esta conta usa um segundo fator que este app não suporta.',
    'app/mfa-bloqueado': 'Muitos códigos errados. Aguarde alguns minutos e tente de novo.',
    'auth/account-exists-with-different-credential': 'Já existe uma conta com este e-mail. Entre com e-mail e senha.',
    'auth/popup-blocked': 'O navegador bloqueou a janela do Google. Libere pop-ups e tente de novo.',
    'app/google-indisponivel': 'O login com Google ainda não foi ativado neste app (veja o LEIA-ME).',
    'auth/operation-not-allowed': 'O login com Google não está ativado no Firebase deste projeto.',
    'auth/unauthorized-domain': 'Este endereço não está autorizado para login com Google no Firebase.',
    'auth/user-disabled': 'Esta conta está indisponível. Fale com o suporte.',
    'auth/requires-recent-login': 'Por segurança, confirme a sua senha e tente de novo.',
    'auth/operation-not-allowed': 'O login por e-mail não está disponível no momento.',
    'permission-denied': 'Você não tem permissão para essa ação.',
    'unavailable': 'Sem conexão com o servidor. Tente de novo.',
    'failed-precondition': 'Não foi possível concluir agora. Tente novamente em instantes.'
  };
  return m[c] || 'Não foi possível concluir agora. Tente novamente em instantes.';
}

async function comBotao(btn, fn){
  const b = typeof btn === 'string' ? $(btn) : btn;
  if(b){ if(b.disabled) return; b.disabled = true; }
  try{ await fn(); }
  catch(e){ console.error(e); toast(msgErro(e), 3600); }
  finally{ if(b) b.disabled = false; }
}

function popularUF(id){
  $(id).innerHTML = '<option value="">UF</option>' + UFS.map(u => `<option value="${u}">${u}</option>`).join('');
}

/* ---------------------------------------------------------------------
   Firebase
   --------------------------------------------------------------------- */
async function initFirebase(){
  let cfg = null;
  try{ cfg = (await import('./firebase-config.js')).firebaseConfig; }catch(e){ console.error(e); }
  if(!cfg || !cfg.apiKey || /^COLE/i.test(cfg.apiKey) || !cfg.projectId || /^COLE/i.test(cfg.projectId)){
    avisoCfg('Firebase ainda não configurado. Cole os dados do seu projeto em www/firebase-config.js (veja o LEIA-ME).');
    return false;
  }
  try{
    const [A, Au, F] = await Promise.all([
      import(CDN + 'firebase-app.js'),
      import(CDN + 'firebase-auth.js'),
      import(CDN + 'firebase-firestore.js')
    ]);
    const app = A.initializeApp(cfg);
    auth = Au.getAuth(app);
    // long polling automático: mais estável dentro do WebView do Android
    db = F.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
    FB = { ...Au, ...F };
    return true;
  }catch(e){
    console.error(e);
    avisoCfg('Não foi possível carregar o Firebase. Verifique a internet e abra o app de novo.');
    return false;
  }
}
const semFirebase = () => { toast('Firebase não está pronto. Veja o aviso na tela inicial.'); };

/* ---------------------------------------------------------------------
   login, cadastro e sessão
   --------------------------------------------------------------------- */
// mostra um erro na tela de login (volta para ela se a sessão falhou no meio do caminho)
function erroNoLogin(e){
  console.error(e);
  if(S.tela !== 's-login') show('s-login');
  loginErro(msgErro(e));
}

const credInvalida = e => ['auth/invalid-credential','auth/wrong-password','auth/user-not-found','auth/invalid-login-credentials'].includes(e && e.code);
async function entrar(){
  if(!FB) return semFirebase();
  const email = val('email'), senha = $('senha').value;
  if(!email || !senha) return loginErro('Informe e-mail e senha.');
  loginErro('');
  // bloqueio temporário: primeiro o do aparelho, depois o do servidor (que vale para qualquer aparelho)
  const lk = SG.bloqueioLocal(email);
  if(lk.bloqueado) return loginErro(`Acesso bloqueado por tentativas inválidas. Tente de novo em ${SG.fmtEspera(lk.restanteSeg)}.`);
  const srv = await SG.seg('/api/seg/pode-entrar', { email });
  if(srv.ok && srv.dados.bloqueado) return loginErro(`Acesso bloqueado por tentativas inválidas. Tente de novo em ${SG.fmtEspera(srv.dados.restanteSeg)}.`);
  await comBotao('btnEntrar', async () => {
    S.autenticando = true;
    try{
      await FB.setPersistence(auth, $('manter').checked ? FB.browserLocalPersistence : FB.browserSessionPersistence);
      const cred = await comMfa(() => FB.signInWithEmailAndPassword(auth, email, senha), email);
      SG.sucessoLocal(email);
      await iniciarSessao(cred.user);
      if(S.tipo) cred.user.getIdToken().then(tk => SG.seg('/api/seg/sucesso-login', {}, tk));
    }catch(e){
      if(e && e.code === 'app/mfa-cancelado') return;
      if(credInvalida(e)){
        const f = SG.falhaLocal(email); SG.seg('/api/seg/falha-login', { email });
        return loginErro(f.bloqueado ? `Muitas tentativas inválidas. Acesso bloqueado por ${SG.fmtEspera(f.restanteSeg)}.`
          : `E-mail ou senha incorretos. Restam ${f.restantes} tentativa${f.restantes === 1 ? '' : 's'} antes do bloqueio temporário.`);
      }
      erroNoLogin(e);
    }
    finally{ S.autenticando = false; }
  });
}

/* ---------- verificação em duas etapas (MFA) ----------
   Usa o MFA do próprio Firebase Authentication (código TOTP de um aplicativo autenticador, RFC 6238).
   Quem exige o segundo fator é o servidor do Google: sem o código, o login não termina, mesmo que o aplicativo seja alterado.
   Precisa estar habilitado no console (Authentication > Método de login > Autenticação multifator, que exige o Identity Platform). */
const MFA_TOTAL = 5;
function pedirCodigoMfa(msg){
  return new Promise(fim => {
    $('mfaErr').textContent = msg || ''; $('mfaCod').value = ''; $('mfaModal').hidden = false; setTimeout(() => $('mfaCod').focus(), 50);
    S.mfaFim = v => { $('mfaModal').hidden = true; S.mfaFim = null; fim(v); };
  });
}
const mfaConfirmar = () => { const v = $('mfaCod').value.replace(/\D/g, ''); if(v.length !== 6) return ($('mfaErr').textContent = 'Digite os 6 números do aplicativo.'); S.mfaFim && S.mfaFim(v); };
const mfaCancelar = () => { S.mfaFim && S.mfaFim(null); };
async function resolverMfa(e, chaveLk){
  const resolver = FB.getMultiFactorResolver(auth, e);
  const hint = resolver.hints.find(h => h.factorId === FB.TotpMultiFactorGenerator.FACTOR_ID);
  if(!hint) throw { code: 'app/mfa-indisponivel' };
  const lk = SG.bloqueioLocal('mfa:' + chaveLk);
  if(lk.bloqueado) throw { code: 'app/mfa-bloqueado', seg: lk.restanteSeg };
  let msg = '';
  for(let i = 0; i < MFA_TOTAL; i++){
    const codigo = await pedirCodigoMfa(msg);
    if(!codigo) throw { code: 'app/mfa-cancelado' };
    try{
      const cred = await resolver.resolveSignIn(FB.TotpMultiFactorGenerator.assertionForSignIn(hint.uid, codigo));
      SG.sucessoLocal('mfa:' + chaveLk); return cred;
    }catch(er){
      if(er && er.code === 'auth/invalid-verification-code'){ SG.falhaLocal('mfa:' + chaveLk); msg = 'Código incorreto ou vencido. Confira o aplicativo e tente de novo.'; continue; }
      throw er;
    }
  }
  throw { code: 'app/mfa-bloqueado', seg: 0 };
}
// executa um login; se o Firebase pedir o segundo fator, abre a janela do código e conclui
async function comMfa(fn, chave){
  try{ return await fn(); }
  catch(e){ if(e && e.code === 'auth/multi-factor-auth-required') return await resolverMfa(e, chave || 'google'); throw e; }
}
const fatorTotp = () => FB.multiFactor(S.user).enrolledFactors.find(f => f.factorId === FB.TotpMultiFactorGenerator.FACTOR_ID);
async function mfaReautenticar(){
  if(temSenha()){
    const s = $('mfaSenha').value; if(!s){ toast('Digite a sua senha para continuar.', 3200); return false; }
    await FB.reauthenticateWithCredential(S.user, FB.EmailAuthProvider.credential(S.user.email, s));
  }else if(nativo()){ const P = googleNativo(); const r = await P.signInWithGoogle({ skipNativeAuth: true }); await comMfa(() => FB.reauthenticateWithCredential(S.user, FB.GoogleAuthProvider.credential(r.credential.idToken))); }
  else await comMfa(() => FB.reauthenticateWithPopup(S.user, new FB.GoogleAuthProvider()));
  return true;
}
function renderMfa(){
  if(!FB || !S.user) return;
  const ativo = !!fatorTotp();
  $('mfaBox').hidden = true; $('mfaSenha').value = ''; $('mfaSenhaBox').hidden = !temSenha();
  $('mfaTxt').textContent = ativo
    ? 'Ativa. Ao entrar, além da senha, o app pede o código de 6 números do seu aplicativo autenticador (Google Authenticator, Authy, Microsoft Authenticator).'
    : 'Desativada. Ative para exigir, além da senha, um código de 6 números gerado no seu celular. Se alguém descobrir a sua senha, ainda não entra.';
  $('mfaAtivar').hidden = ativo; $('mfaDesativar').hidden = !ativo;
}
async function mfaIniciar(){
  await comBotao('mfaAtivar', async () => {
    if(!S.user.emailVerified){
      try{ await FB.sendEmailVerification(S.user); }catch(e){ console.warn(e); }
      return toast('Primeiro confirme o seu e-mail: enviamos um link para ' + S.user.email + '. Depois volte e ative.', 6000);
    }
    if(!await mfaReautenticar()) return;
    const sessao = await FB.multiFactor(S.user).getSession();
    const seg = await FB.TotpMultiFactorGenerator.generateSecret(sessao);
    S.mfaSegredo = seg;
    $('mfaChave').textContent = seg.secretKey.replace(/(.{4})/g, '$1 ').trim();
    const url = seg.generateQrCodeUrl(S.user.email, 'BarbTech');
    $('mfaLink').href = url;
    try{ const q = window.qrcode(0, 'M'); q.addData(url); q.make(); $('mfaQr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
    catch(e){ console.warn('qr:', e); $('mfaQr').textContent = ''; }
    $('mfaEnrCod').value = ''; $('mfaBox').hidden = false;
  });
}
async function mfaConfirmarAtivacao(){
  const codigo = $('mfaEnrCod').value.replace(/\D/g, '');
  if(codigo.length !== 6) return toast('Digite os 6 números que o aplicativo mostra.', 3200);
  await comBotao('mfaEnrBtn', async () => {
    try{ await FB.multiFactor(S.user).enroll(FB.TotpMultiFactorGenerator.assertionForEnrollment(S.mfaSegredo, codigo), 'Aplicativo autenticador'); }
    catch(e){ if(e && e.code === 'auth/invalid-verification-code') return toast('Código incorreto. Confira o aplicativo e tente de novo.', 3600); throw e; }
    S.mfaSegredo = null; renderMfa(); toast('Verificação em duas etapas ativada ✓', 4200);
  });
}
async function mfaDesativar(){
  if(!confirm('Desativar a verificação em duas etapas? A sua conta fica protegida só pela senha.')) return;
  await comBotao('mfaDesativar', async () => {
    if(!await mfaReautenticar()) return;
    await FB.multiFactor(S.user).unenroll(fatorTotp());
    renderMfa(); toast('Verificação em duas etapas desativada.', 3600);
  });
}

/* ---------- login com Google ---------- */
const nativo = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const googleNativo = () => { const C = window.Capacitor; return nativo() ? ((C.Plugins && C.Plugins.FirebaseAuthentication) || (C.registerPlugin ? C.registerPlugin('FirebaseAuthentication') : null)) : null; };
const googleCancelou = e => ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled', 'app/mfa-cancelado'].includes(e && e.code) || /cancel/i.test((e && e.message) || '');
// devolve o usuário logado com a conta Google (janela do Google no navegador; plugin nativo no Android/iOS)
async function loginGoogle(){
  if(nativo()){
    const P = googleNativo();
    if(!P || !P.signInWithGoogle) throw { code: 'app/google-indisponivel' };
    const r = await P.signInWithGoogle({ skipNativeAuth: true });       // só pega o token do Google; quem entra no Firebase é o SDK web
    const tk = r && r.credential && r.credential.idToken;
    if(!tk) throw { code: 'auth/user-cancelled' };
    return (await comMfa(() => FB.signInWithCredential(auth, FB.GoogleAuthProvider.credential(tk)))).user;
  }
  const prov = new FB.GoogleAuthProvider(); prov.setCustomParameters({ prompt: 'select_account' });
  return (await comMfa(() => FB.signInWithPopup(auth, prov))).user;
}
async function entrarGoogle(){
  if(!FB) return semFirebase();
  loginErro('');
  await comBotao('btnGoogle', async () => {
    S.autenticando = true;
    try{
      await FB.setPersistence(auth, $('manter').checked ? FB.browserLocalPersistence : FB.browserSessionPersistence);
      const user = await loginGoogle();
      await iniciarSessao(user);
    }catch(e){
      if(googleCancelou(e)) return;
      erroNoLogin(e);
      // ajuda a achar a causa: mostra o código técnico do erro (não tem dado sensível)
      const cod = (e && (e.code || e.message)) ? String(e.code || e.message).slice(0, 60) : '';
      if(cod) loginErro(msgErro(e) + ' [' + cod + ']');
    }
    finally{ S.autenticando = false; }
  });
}

async function criarConta(){
  if(!FB) return semFirebase();
  if(S.roleChoice === 'pro'){
    prepCadPro(false);
    if($('email').value) $('cp-email').value = val('email');
    return show('s-cadpro');
  }
  prepCadCli();
  if($('email').value) $('cc-email').value = val('email');
  show('s-cadcli');
}

const CAMPOS_CLI = ['cc-nome','cc-tel','cc-cpf','cc-cnpj','cc-cep','cc-cidade','cc-rua','cc-bairro','cc-comp','cc-cond','cc-senha','cc-senha2'];
function prepCadCli(){
  CAMPOS_CLI.forEach(i => $(i).value = '');
  $('cc-uf').value = ''; $('cc-aceito').checked = false; $('cc-email').value = ''; $('cc-erro').textContent = '';
  const i = $('cc-cepInfo'); if(i){ i.textContent = ''; i.className = 'hint cep-info'; }
}
const erroCadCli = t => { $('cc-erro').textContent = t || ''; if(t) toast(t, 3800); };

// Cadastro completo do cliente: acesso + dados pessoais + endereço (validado pelo CEP/cidade) + condição (opcional)
async function cadastrarCli(){
  if(!FB) return semFirebase();
  erroCadCli('');
  const email = val('cc-email'), senha = $('cc-senha').value;
  const d = {
    nome: val('cc-nome'), telefone: val('cc-tel'), estado: $('cc-uf').value, cpf: val('cc-cpf'), cnpj: val('cc-cnpj'),
    logradouroResidencia: val('cc-rua'), bairroResidencia: val('cc-bairro'), cepResi: val('cc-cep'),
    cidadeResidencia: val('cc-cidade'), complementoResidencia: val('cc-comp'), condicao: val('cc-cond').slice(0, 200)
  };
  Object.assign(d, SG.limparObj(d));
  if(!SG.emailValido(email)) return erroCadCli('Informe um e-mail válido.');
  if(!SG.avaliarSenha(senha).ok) return erroCadCli('A senha não atende a todos os requisitos de segurança.');
  if(senha !== $('cc-senha2').value) return erroCadCli('As senhas não conferem.');
  if(!d.nome) return erroCadCli('Informe seu nome.');
  if(!d.telefone) return erroCadCli('Informe seu telefone.');
  if(!d.estado) return erroCadCli('Escolha o estado.');
  { const e = erroDocs(d); if(e) return erroCadCli(e); }
  if(!d.logradouroResidencia || !d.bairroResidencia || !d.cepResi || !d.cidadeResidencia) return erroCadCli('Preencha o endereço (CEP, cidade, rua e bairro).');
  if(!$('cc-aceito').checked) return erroCadCli('Aceite os termos para criar a conta.');
  await comBotao('ccBtn', async () => {
    const v = await validarEndereco(d.cepResi, d.cidadeResidencia, d.estado);
    if(!v.ok) return erroCadCli(v.erro);
    const pos = await geocodificarCep(d.cepResi);
    S.autenticando = true;
    let user = null;
    try{
      await FB.setPersistence(auth, FB.browserLocalPersistence);
      user = (await FB.createUserWithEmailAndPassword(auth, email, senha)).user;
      const dados = { ...CLIENTE_VAZIO, ...d, lat: pos ? pos.lat : null, lng: pos ? pos.lng : null, perfilCompleto: true };
      try{ await FB.setDoc(FB.doc(db, 'clientes', user.uid), dados); await gravarConsent(user.uid, true); }
      catch(e){ await FB.deleteUser(user).catch(() => {}); throw e; }   // desfaz a conta se o perfil não pôde ser criado
      S.roleChoice = 'cliente';
      await exibirCodigoCadastro(user, senha);
      await iniciarSessao(user);
      toast('Conta criada ✓ Bem-vindo ao BarbTech!', 3200);
    }catch(e){ console.error(e); erroCadCli(msgErro(e)); if(S.tela !== 's-cadcli' && !S.user) show('s-cadcli'); }
    finally{ S.autenticando = false; }
  });
}

async function esqueciSenha(){
  if(!FB) return semFirebase();
  const email = val('email');
  if(!email) return loginErro('Digite seu e-mail acima e toque em "Esqueci minha senha".');
  try{
    await FB.sendPasswordResetEmail(auth, email);
    loginErro('');
    toast('Se esse e-mail estiver cadastrado, enviamos um link para redefinir a senha.', 4200);
  }catch(e){ loginErro(msgErro(e)); }
}

function prepCadPro(completando){
  S.completandoPro = completando;
  $('cpAcesso').hidden = completando;
  $('cpTitle').textContent = completando ? 'Complete seu cadastro' : 'Cadastro do profissional';
  $('cpBtn').textContent = completando ? 'Concluir cadastro' : 'Criar conta profissional';
  ['cp-nome','cp-tel','cp-cpf','cp-cnpj','cp-rua','cp-cep','cp-cidade','cp-bairro','cp-comp','cp-senha'].forEach(i => $(i).value = '');
  $('cp-aceito').checked = false; if(pintarCp) pintarCp();
  const ci = $('cp-cepInfo'); if(ci){ ci.textContent = ''; ci.className = 'hint cep-info'; }
  $('cp-uf').value = '';
  $('cp-dom').classList.remove('on');
}
function voltarCadPro(){ S.completandoPro ? sair() : show('s-login'); }

async function cadastrarPro(){
  if(!FB) return semFirebase();
  const email = val('cp-email'), senha = $('cp-senha').value;
  const d = {
    nome: val('cp-nome'), telefone: val('cp-tel'), estado: $('cp-uf').value,
    cpf: val('cp-cpf'), cnpj: val('cp-cnpj'),
    logradouroResidencia: val('cp-rua'), cepResi: val('cp-cep'),
    bairroResidencia: val('cp-bairro'), complementoResidencia: val('cp-comp'), cidadeResidencia: val('cp-cidade')
  };
  if(!S.completandoPro){
    if(!SG.emailValido(email)) return toast('Informe um e-mail válido.');
    if(!SG.avaliarSenha(senha).ok) return toast('A senha não atende a todos os requisitos de segurança.');
  }
  if(!$('cp-aceito').checked) return toast('Aceite a política de privacidade para continuar.');
  if(!d.nome) return toast('Informe seu nome.');
  if(!d.telefone) return toast('Informe seu telefone.');
  if(!d.estado) return toast('Escolha o estado.');
  { const e = erroDocs(d); if(e) return toast(e, 4000); }
  if(!d.logradouroResidencia || !d.cepResi || !d.bairroResidencia || !d.cidadeResidencia) return toast('Preencha o endereço (CEP, cidade, rua e bairro).');

  await comBotao('cpBtn', async () => {
    const v = await validarEndereco(d.cepResi, d.cidadeResidencia, d.estado);
    if(!v.ok) return toast(v.erro, 4200);
    S.autenticando = true;
    let user = null, criou = false;
    try{
      if(S.completandoPro){ user = auth.currentUser; }
      else{
        await FB.setPersistence(auth, FB.browserLocalPersistence);
        user = (await FB.createUserWithEmailAndPassword(auth, email, senha)).user;
        criou = true;
      }
      const uid = user.uid;
      const pos = await geocodificarCep(d.cepResi);
      const priv = { cpf:d.cpf, cnpj:d.cnpj, logradouroResidencia:d.logradouroResidencia, bairroResidencia:d.bairroResidencia, cepResi:d.cepResi, cidadeResidencia:d.cidadeResidencia, complementoResidencia:d.complementoResidencia };
      const batch = FB.writeBatch(db);
      batch.set(FB.doc(db, 'profissionais', uid), {
        nome: d.nome, telefone: d.telefone, estado: d.estado,
        atendeDomicilio: $('cp-dom').classList.contains('on'), barbeariaId: null, sobre: '', fotoUrl: '', taxaDomicilio: TAXA_DOMICILIO,
        lat: pos ? aprox(pos.lat) : null, lng: pos ? aprox(pos.lng) : null
      });
      batch.set(FB.doc(db, 'profissionais', uid, 'privado', 'dados'), priv);
      batch.set(FB.doc(db, 'agendas', uid), { profissionalId: uid, horarios: HORARIOS_PADRAO, horariosDomicilio: HORARIOS_DOM_PADRAO });
      try{ await batch.commit(); }
      catch(e){ if(criou) await FB.deleteUser(user).catch(() => {}); throw e; }
      await gravarConsent(uid, true);
      if(criou) await exibirCodigoCadastro(user, senha);
      await iniciarSessao(user);
    }catch(e){
      console.error(e);
      toast(msgErro(e), 3800);
    }finally{ S.autenticando = false; }
  });
}

// Descobre se a conta é cliente ou profissional e abre a tela certa.
async function iniciarSessao(user){
  S.user = user; S.sessaoUid = user.uid;
  const uid = user.uid;
  try{
    const [c, p] = await Promise.all([
      FB.getDoc(FB.doc(db, 'clientes', uid)),
      FB.getDoc(FB.doc(db, 'profissionais', uid))
    ]);
    if(p.exists()){ S.tipo = 'pro'; S.perfil = p.data(); }
    else if(c.exists()){ S.tipo = 'cliente'; S.perfil = c.data(); }
    else if(S.roleChoice === 'pro'){ S.tipo = null; prepCadPro(true); show('s-cadpro'); return; }
    else{
      await FB.setDoc(FB.doc(db, 'clientes', uid), CLIENTE_VAZIO);
      S.tipo = 'cliente'; S.perfil = { ...CLIENTE_VAZIO };
    }

    // consentimento: sem aceite da versão atual da política, não segue
    S.consent = await lerConsent(uid);
    if(!S.consent || S.consent.versao !== POLITICA_VERSAO){ abrirPrivacidade(true); return; }

    S.bannerProprio = '';
    S.pushOuvindo = S.pushOuvindo || false;
    iniciarTimeout();
    if(S.tipo === 'pro'){
      await carregarPro();
      iniciarListeners();
      carregarBannerProprio(); completarCoordenadas(); retomarPush();
      if(!S.servicos.length){ show('s-pro'); toast('Cadastre seus serviços para receber agendamentos.', 3600); }
      else show('s-pagenda');
    }else{
      await carregarPublico();
      iniciarListeners();
      carregarBannerProprio(); completarCoordenadas(); retomarPush();
      if(S.perfil.perfilCompleto) show('s-home');
      else{ show('s-me'); toast('Complete seu perfil para poder agendar.', 3200); }
    }
  }catch(e){
    // não deixa a conta "meio aberta": limpa e devolve o erro para quem chamou mostrar
    S.sessaoUid = null; S.tipo = null; pararListeners();
    const rede = ['unavailable','auth/network-request-failed'].includes(e && e.code);
    if(!rede) await FB.signOut(auth).catch(() => {});
    throw e;
  }
}

function logoutView(){
  pararListeners();
  Object.assign(S, { user:null, tipo:null, perfil:null, privado:null, sessaoUid:null, completandoPro:false,
    pros:[], servicos:[], barbearias:{}, agendas:{}, agendasDom:{}, pubTs:0, agds:[], notifs:[], pro:null, remarcando:null, destaque:null, bannerProprio:'', banners:{}, pushToken:null, promos:[], promosPro:[], promoEdit:null, consent:null });
  SG.pararInatividade(); try{ localStorage.removeItem('bt_ult'); }catch(e){}
  if(bot) bot.resetar();
  $('senha').value = ''; loginErro('');
  show('s-splash');
}
async function sair(){
  try{ await removerToken(); }catch(e){ console.warn(e); }
  try{ if(FB) await FB.signOut(auth); }catch(e){ console.error(e); }
  logoutView();
}

/* ---------------------------------------------------------------------
   carga de dados
   --------------------------------------------------------------------- */
const servicosDe = pid => S.servicos.filter(s => s.profissionalId === pid).sort((a,b) => a.nome.localeCompare(b.nome));
const servicoPorId = id => S.servicos.find(s => s.id === id);
const servicoSel = () => servicoPorId(S.sel.servicoId);
const nomeBarbearia = p => (p && p.barbeariaId && S.barbearias[p.barbeariaId]) ? S.barbearias[p.barbeariaId].nome : '';
const subPro = p => [nomeBarbearia(p) || 'Profissional independente', p.atendeDomicilio ? 'atende em casa' : ''].filter(Boolean).join(' · ');
const docs = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));

// Cliente: lê os perfis públicos, serviços e barbearias.
// Cada leitura é independente: se uma falhar (ex.: regra antiga do Firestore), o app abre com o que deu certo
// e avisa qual coleção falhou, em vez de derrubar o login inteiro.
async function carregarPublico(){
  const nomes = ['profissionais', 'servicos', 'barbearias', 'agendas', 'promocoes'];
  const rs = await Promise.allSettled(nomes.map(n => FB.getDocs(n === 'promocoes'
    ? FB.query(FB.collection(db, n), FB.where('validaAte', '>=', hojeStr()))
    : FB.collection(db, n))));
  const falhas = [];
  rs.forEach((r, i) => { if(r.status === 'rejected'){ falhas.push(`${nomes[i]} (${(r.reason && r.reason.code) || 'erro'})`); console.error('carregarPublico:', nomes[i], r.reason); } });
  const lista = i => rs[i].status === 'fulfilled' ? docs(rs[i].value) : null;
  const ps = lista(0), ss = lista(1), bs = lista(2), ags = lista(3), prs = lista(4);
  if(prs) S.promos = prs.filter(promoVigente);
  if(ps) S.pros = ps.sort((a,b) => (a.nome||'').localeCompare(b.nome||''));
  if(ss) S.servicos = ss;
  if(bs) S.barbearias = Object.fromEntries(bs.map(b => [b.id, b]));
  if(ags){
    S.agendas = Object.fromEntries(ags.map(a => [a.id, a.horarios || {}]));   // horários de trabalho (usados pelo assistente)
    S.agendasDom = Object.fromEntries(ags.map(a => [a.id, a.horariosDomicilio || {}]));
  }
  S.pubTs = Date.now();
  if(falhas.length === nomes.length){ const e = new Error('Não foi possível ler os dados: ' + falhas.join(', ')); e.code = (rs[0].reason && rs[0].reason.code) || 'unavailable'; throw e; }
  if(falhas.length) toast('Parte dos dados não carregou. Verifique a internet e tente de novo.', 5000);
}
async function refreshPublico(){
  if(S.tipo !== 'cliente' || Date.now() - S.pubTs < 20000) return;
  try{ await carregarPublico(); LIVE[S.tela] && LIVE[S.tela](); }catch(e){ console.warn(e); }
}

// Profissional: lê agenda, serviços próprios, dados privados e barbearias.
async function carregarPro(){
  const uid = S.user.uid;
  const [ag, sv, pv, bs, pm] = await Promise.all([
    FB.getDoc(FB.doc(db, 'agendas', uid)),
    FB.getDocs(FB.query(FB.collection(db, 'servicos'), FB.where('profissionalId', '==', uid))),
    FB.getDoc(FB.doc(db, 'profissionais', uid, 'privado', 'dados')),
    FB.getDocs(FB.query(FB.collection(db, 'barbearias'), FB.where('donoId', '==', uid))),   // só as barbearias deste profissional
    FB.getDocs(FB.query(FB.collection(db, 'promocoes'), FB.where('profissionalId', '==', uid))).catch(e => { console.warn('promocoes:', e); return null; })
  ]);
  S.promosPro = pm ? docs(pm).sort((a, b) => (b.validaAte || '').localeCompare(a.validaAte || '')) : [];
  S.horariosPro = { ...HORARIOS_PADRAO, ...((ag.exists() && ag.data().horarios) || {}) };
  S.horariosDom = { ...HORARIOS_DOM_PADRAO, ...((ag.exists() && ag.data().horariosDomicilio) || {}) };
  S.servicos = docs(sv);
  S.privado = pv.exists() ? pv.data() : {};
  S.barbearias = Object.fromEntries(docs(bs).map(b => [b.id, b]));
}

function pararListeners(){ S.unsubs.forEach(u => { try{ u(); }catch(e){} }); S.unsubs = []; }
function iniciarListeners(){
  pararListeners();
  const uid = S.user.uid, campo = S.tipo === 'pro' ? 'profissionalId' : 'clienteId';
  S.unsubs.push(FB.onSnapshot(
    FB.query(FB.collection(db, 'agendamentos'), FB.where(campo, '==', uid)),
    snap => { S.agds = docs(snap).sort(porDataHora); if(LIVE[S.tela]) LIVE[S.tela](); },
    err => console.warn('agendamentos:', err)
  ));
  S.unsubs.push(FB.onSnapshot(
    FB.query(FB.collection(db, 'notificacoes'), FB.where('destinatarioId', '==', uid)),
    snap => { S.notifs = docs(snap); renderBell(); if(S.tela === 's-notif') renderNotif(); },
    err => console.warn('notificacoes:', err)
  ));
}

/* ---------------------------------------------------------------------
   notificações
   --------------------------------------------------------------------- */
function renderBell(){
  document.querySelectorAll('.bell').forEach(b => b.classList.toggle('has-dot', S.notifs.length > 0));
}
function abrirNotif(){ S.voltarPara = S.tela; show('s-notif'); }
function voltarNotif(){ show(S.voltarPara && S.voltarPara !== 's-notif' ? S.voltarPara : (S.tipo === 'pro' ? 's-pagenda' : 's-home')); }
function renderNotif(){
  renderBell();
  const l = [...S.notifs].sort((a,b) => b.id.localeCompare(a.id));
  $('notifList').innerHTML = l.length
    ? l.map(n => `<div class="note"><span class="ic">${ICON_BELL}</span><span>${esc(n.mensagem)}</span></div>`).join('')
    : '<div class="empty">Nenhuma notificação.</div>';
}
async function limparNotif(){
  if(!S.notifs.length) return;
  if(!confirm('Apagar todas as notificações?')) return;
  try{
    const batch = FB.writeBatch(db);
    S.notifs.forEach(n => batch.delete(FB.doc(db, 'notificacoes', n.id)));
    await batch.commit();
  }catch(e){ console.error(e); toast(msgErro(e)); }
}
function addNotif(batch, destinatarioId, agendamentoId, tipo, mensagem){
  batch.set(FB.doc(db, 'notificacoes', notifId()), { destinatarioId, agendamentoId, tipo, mensagem });
}

/* ---------------------------------------------------------------------
   CLIENTE — início, lista de barbeiros
   --------------------------------------------------------------------- */
function cardAgdCliente(a, comAcoes){
  const sv = servicoPorId(a.servicoId), pro = S.pros.find(p => p.id === a.profissionalId);
  const st = STATUS[a.status] || { t: a.status, c: '' };
  // Remarcar vale para qualquer horário ainda ativo (inclusive um que já passou sem ser atendido); cancelar só para os futuros.
  const acts = (comAcoes && ativo(a))
    ? `<div class="acts"><button class="btn btn-line btn-sm" data-act="remarcar" data-id="${esc(a.id)}">Remarcar</button>`
      + (futuro(a) ? `<button class="btn btn-danger btn-sm" data-act="cancelarCli" data-id="${esc(a.id)}">Cancelar</button>` : '') + '</div>' : '';
  return `<div class="acard"><div class="top"><span class="ic">${ICON_CAL}</span>
    <span class="tx"><b>${esc(sv ? sv.nome : 'Serviço removido')}</b>
    <span>${esc(dataCurta(a.data))} · ${esc(a.horario)} · ${esc(pro ? pro.nome : 'Profissional')}</span>
    ${a.localAtendimento === 'DOMICILIO'
      ? `<span>🏠 Em casa: ${esc(a.enderecoCliente || 'endereço do seu perfil')}</span>`
      : (() => { const l = a.enderecoLocal || localDoPro(pro); return `<span>📍 ${l ? esc(l) + linkMapa(l) : 'Local a combinar com o profissional'}</span>`; })()}
    ${a.desconto ? `<span>🏷 ${esc(a.promocaoTitulo || 'Promoção')} (−${esc(a.desconto)}%)</span>` : ''}</span>
    <span class="st ${st.c}">${st.t}</span></div>${acts}</div>`;
}

function renderHome(){
  renderBell();
  renderDestaques();
  const av = $('homeAvatars'), ft = $('homeFeature');
  const reg = prosRegiao();
  if(!reg.length){
    av.innerHTML = '';
    ft.innerHTML = S.pros.length
      ? `<div class="empty">Nenhum profissional em até ${S.raio} km do seu CEP.<br><button class="chip" style="margin-top:10px" data-act="verTodasRegioes">Ver todas as regiões</button></div>`
      : '<div class="empty">Nenhum profissional cadastrado ainda.<br>Volte em breve!</div>';
  }else{
    const lista = ordenarPros(reg);
    if(!reg.some(p => p.id === S.destaque)) S.destaque = lista[0].id;
    av.innerHTML = lista.map(p =>
      `<div class="av ${p.id === S.destaque ? 'on' : ''}" data-act="destaque" data-id="${esc(p.id)}">${picHtml(p)}<span>${esc(primeiroNome(p.nome))}</span></div>`).join('');
    const p = reg.find(x => x.id === S.destaque);
    const dh = distTxt(p);
    ft.innerHTML = `<article class="feature">${picHtml(p)}
      <div class="body"><h3>${esc(p.nome)}</h3><div class="role-txt">${esc(subPro(p))}${dh ? ' · 📍 ' + esc(dh) : ''}</div>
      <p>${esc(p.sobre || 'Este profissional ainda não escreveu a apresentação.')}</p>
      <button class="btn btn-gold" style="margin-top:16px" data-act="abrirPro" data-id="${esc(p.id)}">Ver agenda</button></div></article>`;
  }
  const prox = S.agds.find(proximo);
  $('homeNext').innerHTML = prox ? cardAgdCliente(prox, false)
    : '<div class="empty">Você ainda não tem horários marcados.</div>';
}

function renderDestaques(){
  const rail = $('rail'), dots = $('railDots');
  const proDe = id => S.pros.find(p => p.id === id && naRegiao(p));
  const lista = S.promos.filter(pr => promoVigente(pr) && proDe(pr.profissionalId))
    .sort((a, b) => (a.tipo === b.tipo ? (+b.desconto - +a.desconto) : (a.tipo === 'PROMOCAO' ? -1 : 1)));
  if(!lista.length){
    rail.innerHTML = `<div class="shot ph destaque vazio"><span class="lbl"><b>Novidades e promoções</b><span>Quando um barbeiro publicar um desconto ou uma novidade, aparece aqui.</span></span></div>`;
    dots.innerHTML = ''; return;
  }
  rail.innerHTML = lista.map(pr => {
    const p = proDe(pr.profissionalId), promo = pr.tipo === 'PROMOCAO';
    const sv = pr.servicoId ? servicoPorId(pr.servicoId) : null;
    const selo = promo ? `−${esc(pr.desconto)}%` : 'NOVIDADE';
    const meta = [`com ${esc(primeiroNome(p.nome))}`, promo && sv ? esc(sv.nome) : '', pr.validaAte ? 'até ' + dataBr(pr.validaAte) : ''].filter(Boolean).join(' · ');
    return `<button class="shot destaque ${promo ? 'promo' : 'novo'}" data-act="abrirPromo" data-id="${esc(pr.id)}">
      <i class="selo">${selo}</i>
      <span class="lbl"><b>${esc(pr.titulo)}</b><span>${esc(pr.descricao || '')}</span><span class="meta">${meta}</span></span></button>`;
  }).join('');
  dots.innerHTML = lista.map((_, i) => `<i class="dot ${i ? '' : 'on'}"></i>`).join('');
}
function abrirPromo(id){
  const pr = S.promos.find(x => x.id === id); if(!pr) return;
  return abrirPro(pr.profissionalId, null, pr.servicoId || null);
}

function irBusca(){ show('s-barbers'); setTimeout(() => $('busca').focus(), 60); }
function toggleFiltro(){
  S.soDomicilio = !S.soDomicilio;
  $('btnFiltro').classList.toggle('has-dot', S.soDomicilio);
  $('filtroInfo').hidden = !S.soDomicilio;
  renderBarbers();
}
// filtro por região: só mostra profissionais dentro do raio (km) a partir do CEP do cliente; 0 = todas as regiões
const RAIOS = [10, 25, 50, 100, 0];
function lerRaio(){ try{ const v = localStorage.getItem('bt_raio'); return v === null ? 50 : ([10,25,50,100,0].includes(+v) ? +v : 50); }catch(e){ return 50; } }
function setRaio(v){
  S.raio = RAIOS.includes(+v) ? +v : 50;
  try{ localStorage.setItem('bt_raio', String(S.raio)); }catch(e){}
  renderBarbers(); if(S.tela === 's-home') renderHome();
}
const filtraRegiao = () => !!posCliente() && S.raio > 0;
// sem CEP do profissional não dá para saber se ele é da região, então fica de fora enquanto o filtro estiver ligado
const naRegiao = p => { if(!filtraRegiao()) return true; const k = kmDoPro(p); return k != null && k <= S.raio; };
const prosRegiao = () => S.pros.filter(naRegiao);
// com a posição do cliente conhecida e "Mais próximos" ligado, ordena do mais perto para o mais longe (sem CEP vão para o fim)
function ordenarPros(l){
  const base = [...l].sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
  if(!(S.perto && posCliente())) return base;
  const k = p => { const v = kmDoPro(p); return v == null ? Infinity : v; };
  return base.sort((a, b) => k(a) - k(b));
}
function togglePerto(){
  if(!posCliente()){
    toast('Cadastre seu CEP no perfil para ver quem está mais perto.', 3600);
    return show('s-me');
  }
  S.perto = !S.perto; renderBarbers();
}
function renderBarbers(){
  const q = norm($('busca').value), tenho = !!posCliente();
  let l = prosRegiao().filter(p => !S.soDomicilio || p.atendeDomicilio);
  const fora = S.pros.length - prosRegiao().length;
  const selR = $('selRaio'); if(selR){ selR.value = String(S.raio); selR.hidden = !tenho; }
  if(q) l = l.filter(p => norm(p.nome).includes(q) || norm(nomeBarbearia(p)).includes(q) || servicosDe(p.id).some(s => norm(s.nome).includes(q)));
  l = ordenarPros(l);
  const ordenado = S.perto && tenho;
  $('btnPerto').classList.toggle('on', ordenado);
  $('geoInfo').textContent = tenho ? ((S.raio > 0 ? `Até ${S.raio} km do seu CEP` : 'Todas as regiões') + (ordenado ? ', do mais perto ao mais longe.' : ', em ordem alfabética.') + (fora > 0 ? ` ${fora} fora da sua região.` : ''))
    : (S.perfil && cepValido(S.perfil.cepResi) ? 'Procurando a sua localização…' : 'Cadastre seu CEP no perfil para ver a distância.');
  $('barbersSub').textContent = l.length === 1 ? '1 profissional disponível.' : `${l.length} profissionais disponíveis.`;
  $('barbersList').innerHTML = l.length ? l.map((p, i) => {
    const tags = servicosDe(p.id).slice(0, 2).map((s, i) => `<i class="tag ${i ? 'plain' : ''}">${esc(s.nome)}</i>`).join('')
      + (p.atendeDomicilio ? '<i class="tag plain">Em casa</i>' : '');
    const dt = distTxt(p);
    const dist = dt ? `<i class="dist">${ordenado && i === 0 ? '⭐ Mais próximo · ' : '📍 '}${esc(dt)}</i>` : '';
    return `<button class="barber" data-act="abrirPro" data-id="${esc(p.id)}">${picHtml(p)}
      <span style="flex:1;min-width:0"><h3>${esc(p.nome)}</h3><div class="sub">${esc(subPro(p))}</div><span class="tags">${dist}${tags}</span></span></button>`;
  }).join('') : (fora > 0 && !q ? `<div class="empty">Nenhum profissional na sua região (até ${S.raio} km).<br><button class="chip" style="margin-top:10px" data-act="verTodasRegioes">Ver todas as regiões</button></div>` : '<div class="empty">Nenhum profissional encontrado.</div>');
  if(l.length && fora > 0 && S.raio > 0 && !q) $('barbersList').insertAdjacentHTML('beforeend', `<div class="empty" style="margin-top:6px">${fora} profissional${fora === 1 ? '' : 'is'} fora de ${S.raio} km do seu CEP.<br><button class="chip" style="margin-top:10px" data-act="verTodasRegioes">Ver todas as regiões</button></div>`);
}

function renderMeus(){
  renderBell();
  const prox = S.agds.filter(proximo), ant = S.agds.filter(a => !proximo(a)).reverse();
  $('meusProx').innerHTML = prox.length ? prox.map(a => cardAgdCliente(a, true)).join('') : '<div class="empty">Nenhum horário marcado.</div>';
  $('meusAnt').innerHTML = ant.length ? ant.map(a => cardAgdCliente(a, true)).join('') : '<div class="empty">Nada por aqui ainda.</div>';
}

/* ---------------------------------------------------------------------
   CLIENTE — perfil do barbeiro e agendamento
   --------------------------------------------------------------------- */
async function abrirPro(id, remarcar, servicoId){
  const p = S.pros.find(x => x.id === id);
  if(!p) return toast('Profissional não encontrado.');
  S.origem = S.tela === 's-barber' ? S.origem : S.tela;
  S.pro = p; S.agendaPro = null; S.remarcando = remarcar || null;
  // ao remarcar, o local (barbearia ou casa) não muda
  S.sel = { servicoId: remarcar ? remarcar.servicoId : (servicoId || null), dia: null, hora: null, dom: !!(remarcar && remarcar.localAtendimento === 'DOMICILIO') };
  S.ocupados = new Set(); S.calRef = new Date(); S.calRef.setDate(1);
  // fluxo normal: Serviços → Agenda. Ao remarcar o serviço já está definido, então abre direto na Agenda.
  const inicial = remarcar ? 'p-agenda' : 'p-svc';
  document.querySelectorAll('#s-barber .tab').forEach((t, i) => t.classList.toggle('on', ['p-svc', 'p-agenda', 'p-sobre'][i] === inicial));
  document.querySelectorAll('#s-barber .tabpanel').forEach(x => x.classList.toggle('on', x.id === inicial));
  show('s-barber');
  try{
    const [ag, sv, bn] = await Promise.all([
      FB.getDoc(FB.doc(db, 'agendas', id)),
      FB.getDocs(FB.query(FB.collection(db, 'servicos'), FB.where('profissionalId', '==', id))),
      S.banners[id] !== undefined ? Promise.resolve(null) : FB.getDoc(FB.doc(db, 'profissionais', id, 'midia', 'banner')).catch(() => null)
    ]);
    if(bn) S.banners[id] = bn.exists() ? (bn.data().dataUrl || '') : '';
    if(S.pro !== p) return;
    S.agendaPro = { horarios: { ...HORARIOS_PADRAO, ...((ag.exists() && ag.data().horarios) || {}) }, domicilio: { ...HORARIOS_DOM_PADRAO, ...((ag.exists() && ag.data().horariosDomicilio) || {}) } };
    S.servicos = S.servicos.filter(s => s.profissionalId !== id).concat(docs(sv));
  }catch(e){
    console.error(e); toast(msgErro(e));
    if(S.pro !== p) return;
    S.agendaPro = { horarios: { ...HORARIOS_PADRAO }, domicilio: { ...HORARIOS_DOM_PADRAO } };
  }
  if(!S.sel.servicoId || !servicoPorId(S.sel.servicoId)) S.sel.servicoId = (servicosDe(id)[0] || {}).id || null;
  S.sel.dia = primeiroDiaLivre();
  if(S.sel.dia){ const d = parseYmd(S.sel.dia); S.calRef = new Date(d.getFullYear(), d.getMonth(), 1); }
  renderBarber();
  await carregarSlots();
}

function voltarBarber(){
  const era = S.remarcando;
  S.remarcando = null;
  show(era ? 's-meus' : (S.origem || 's-barbers'));
}

// horários de trabalho do modo escolhido (barbearia ou casa)
const horariosModo = () => S.agendaPro ? (S.sel.dom ? S.agendaPro.domicilio : S.agendaPro.horarios) : {};

function primeiroDiaLivre(){
  const sv = servicoSel(), dur = sv ? sv.duracaoMin : SLOT_MIN;
  const agora = new Date(), min = agora.getHours() * 60 + agora.getMinutes();
  for(let i = 0; i < 62; i++){
    const d = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + i);
    const h = horariosModo()[DIAS[d.getDay()]];
    const slots = geraSlots(h, dur).filter(t => i > 0 || toMin(t) > min);
    if(slots.length) return ymd(d);
  }
  return null;
}

function renderBarber(){
  const p = S.pro; if(!p) return;
  $('bName').textContent = p.nome; const dh = distTxt(p); $('bSub').textContent = subPro(p) + (dh ? ' · 📍 ' + dh : '');
  setAvatar($('bAvatar'), p); setCover($('bCover'), S.banners[p.id]);
  const bn = $('bBanner');
  bn.hidden = !S.remarcando;
  if(S.remarcando) bn.textContent = 'Remarcando: escolha o novo dia e horário e confirme no botão abaixo.';

  const svs = servicosDe(p.id);
  $('svcList').innerHTML = svs.length ? svs.map(s =>
    `<button class="svc ${s.id === S.sel.servicoId ? 'on' : ''}" data-act="svc" data-id="${esc(s.id)}"><span class="mark">✓</span>
     <span class="n"><b>${esc(s.nome)}</b><span>${esc(s.duracaoMin)} min${(() => { const pr = promoPara(p, s); return pr ? ` · <i class="tagpromo">−${esc(pr.desconto)}% ${esc(pr.titulo)}</i>` : ''; })()}</span></span>
     <span class="p">${(() => { const x = precoDe(p, s); return x.promo && !S.remarcando ? `<s>${dinheiro(x.base)}</s> ${dinheiro(x.valor)}` : dinheiro(x.base); })()}</span></button>`).join('')
    : '<div class="empty">Este profissional ainda não cadastrou serviços.</div>';

  // duas abas: na barbearia ou em casa (só se o profissional atende em domicílio; ao remarcar o local é fixo)
  const abas = !!p.atendeDomicilio && !S.remarcando;
  $('modoTabs').hidden = !abas;
  document.querySelectorAll('#modoTabs .modo').forEach(b => b.classList.toggle('on', (b.dataset.id === 'casa') === !!S.sel.dom));
  const info = $('modoInfo');
  info.hidden = !(S.sel.dom && (abas || S.remarcando));
  if(!info.hidden) info.textContent = `${primeiroNome(p.nome)} vai até o endereço do seu perfil · deslocamento ${dinheiro(taxaDe(p))}.`
    + (S.perfil && S.perfil.logradouroResidencia ? '' : ' Cadastre seu endereço no perfil para pedir em casa.');
  $('modoLeg').textContent = S.sel.dom ? 'em casa' : 'na barbearia';

  // sobre
  $('bSobre').textContent = p.sobre || 'Este profissional ainda não escreveu a apresentação.';
  $('bMetrics').innerHTML =
    `<div class="metric"><span>Serviços</span><b>${svs.length}</b><small>cadastrados</small></div>
     <div class="metric"><span>Atende em casa</span><b>${p.atendeDomicilio ? 'Sim' : 'Não'}</b><small>${p.atendeDomicilio ? dinheiro(taxaDe(p)) + ' de deslocamento' : 'só na barbearia'}</small></div>`;
  const b = barbeariaDe(p);
  const end = enderecoBarbearia(b);
  const lista = hs => ORDEM_SEMANA.map(i => { const h = hs[DIAS[i]]; return h && h.aberto ? `${DIAS_NOME[i]}: ${esc(h.inicio)} às ${esc(h.fim)}` : null; }).filter(Boolean).join('<br>');
  const horas = S.agendaPro
    ? ('<b>Na barbearia</b><br>' + (lista(S.agendaPro.horarios) || 'sem dias definidos'))
      + (p.atendeDomicilio ? '<br><br><b>Em casa</b><br>' + (lista(S.agendaPro.domicilio) || 'sem dias definidos') : '')
    : '';
  $('bLocal').innerHTML = (b ? `<div style="font-size:13.5px">${esc(b.nome)}</div><div class="tiny muted" style="margin-top:4px">${esc(end) || 'Endereço não informado'}</div>`
      : '<div style="font-size:13.5px">Sem endereço fixo cadastrado</div>')
    + (horas ? `<div class="tiny muted" style="margin-top:10px">${horas}</div>` : '')
    + (end ? `<a class="btn btn-line btn-sm link" style="margin-top:12px" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(end)}">Ver no mapa</a>` : '');

  renderCal(); renderSlots(); renderResumo();
}

function renderCal(){
  const cal = $('cal'), ref = S.calRef, y = ref.getFullYear(), m = ref.getMonth();
  const hoje = new Date(), hoje0 = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const limite = new Date(hoje.getFullYear(), hoje.getMonth() + JANELA_MESES + 1, 0);
  const atual = (y - hoje.getFullYear()) * 12 + m - hoje.getMonth();
  $('calTitle').textContent = `${MESES[m]} ${y}`;
  $('calPrev').disabled = atual <= 0; $('calNext').disabled = atual >= JANELA_MESES;
  let h = ['D','S','T','Q','Q','S','S'].map(d => `<div class="wd">${d}</div>`).join('');
  for(let i = 0; i < new Date(y, m, 1).getDay(); i++) h += '<div class="day off"></div>';
  for(let d = 1; d <= new Date(y, m + 1, 0).getDate(); d++){
    const dt = new Date(y, m, d), k = ymd(dt);
    const hor = S.agendaPro && horariosModo()[DIAS[dt.getDay()]];
    const livre = !!(hor && hor.aberto) && dt >= hoje0 && dt <= limite;
    h += livre ? `<button class="day free ${k === S.sel.dia ? 'on' : ''}" data-act="dia" data-id="${k}">${d}</button>`
               : `<button class="day off" disabled>${d}</button>`;
  }
  cal.innerHTML = h;
}
function mesCal(delta){
  const hoje = new Date(), ref = S.calRef;
  const atual = (ref.getFullYear() - hoje.getFullYear()) * 12 + ref.getMonth() - hoje.getMonth();
  const novo = atual + delta;
  if(novo < 0 || novo > JANELA_MESES) return;
  S.calRef = new Date(hoje.getFullYear(), hoje.getMonth() + novo, 1);
  renderCal();
}

// Lê no Firestore os blocos já ocupados de um profissional num dia (documentId entre profId_AAAAMMDD_0000 e _2359).
// ignorarAgdId: os blocos desse agendamento contam como livres (usado ao remarcar). Lança o erro se a leitura falhar.
async function ocupadosDoDia(pid, dia, ignorarAgdId, ignorarIds){
  const k = dia.replace(/-/g, ''), ocup = new Set();
  const snap = await FB.getDocs(FB.query(FB.collection(db, 'horariosOcupados'),
    FB.where(FB.documentId(), '>=', `${pid}_${k}_0000`),
    FB.where(FB.documentId(), '<=', `${pid}_${k}_2359`)));
  snap.docs.forEach(d => {
    if(ignorarAgdId && d.data().agendamentoId === ignorarAgdId) return;
    if(ignorarIds && ignorarIds.has(d.id) && d.data().clienteId === (S.user && S.user.uid)) return;
    ocup.add(horaDoId(d.id));
  });
  return ocup;
}

async function carregarSlots(){
  const dia = S.sel.dia, pid = S.pro && S.pro.id, req = ++S.slotReq;
  if(!dia || !pid){ S.ocupados = new Set(); renderSlots(); renderResumo(); return; }
  $('slots').innerHTML = '<p class="tiny muted" style="grid-column:1/-1">Carregando horários…</p>';
  let ocup = new Set();
  try{ ocup = await ocupadosDoDia(pid, dia, S.remarcando && S.remarcando.id, S.remarcando && blocosAtuais(S.remarcando)); }
  catch(e){ console.error(e); toast(msgErro(e)); }
  if(req !== S.slotReq) return;
  S.ocupados = ocup;
  renderSlots(); renderResumo();
}

function renderSlots(){
  const box = $('slots');
  if(!S.agendaPro || !S.sel.dia){
    $('dayLabel').textContent = '—';
    box.innerHTML = `<p class="tiny muted" style="grid-column:1/-1">${S.agendaPro ? (S.sel.dom ? 'Este profissional ainda não definiu dias de atendimento em casa.' : 'Este profissional não tem dias livres nos próximos meses.') : 'Carregando…'}</p>`;
    return;
  }
  const d = parseYmd(S.sel.dia);
  $('dayLabel').textContent = `${DIAS_ABREV[d.getDay()]}, ${d.getDate()}`;
  const sv = servicoSel(), dur = sv ? sv.duracaoMin : SLOT_MIN;
  const cands = candidatosDoDia(horariosModo(), S.sel.dia, dur);
  const livre = t => slotLivre(t, dur, S.ocupados);
  if(S.sel.hora && !(cands.includes(S.sel.hora) && livre(S.sel.hora))) S.sel.hora = null;
  box.innerHTML = cands.length
    ? cands.map(t => `<button class="slot ${t === S.sel.hora ? 'on' : ''}" ${livre(t) ? '' : 'disabled'} data-act="slot" data-id="${t}">${t}</button>`).join('')
    : '<p class="tiny muted" style="grid-column:1/-1">Sem horários livres nesse dia.</p>';
}

function renderResumo(){
  const sv = servicoSel(), dom = !!(S.sel.dom && S.pro);
  $('sSvc').textContent = sv ? sv.nome : 'Escolha um serviço';
  $('sWhen').textContent = S.sel.dia ? `${dataCurta(S.sel.dia)} · ${S.sel.hora || '—'}` : '—';
  $('sDur').textContent = sv ? `${sv.duracaoMin} min` : '—';
  $('rowDom').style.display = dom ? 'flex' : 'none';
  $('sDomTaxa').textContent = dinheiro(taxaDe(S.pro));
  // onde o atendimento acontece: endereço da barbearia, ou a casa do cliente (com a condição informada)
  const rem = S.remarcando, pr = (sv && S.pro && !rem) ? precoDe(S.pro, sv) : null;
  $('rowPromo').style.display = pr && pr.promo ? 'flex' : 'none';
  if(pr && pr.promo) $('sPromo').textContent = `−${pr.desconto}% (${pr.promo.titulo})`;
  let local = '', aviso = '';
  if(S.pro){
    if(dom){
      const eu = S.perfil || {};
      local = eu.logradouroResidencia ? 'Na sua casa: ' + enderecoTexto(eu) : 'Cadastre seu endereço no perfil';
      aviso = !consentOk('condicao') ? 'Seu endereço será enviado ao profissional. Sua condição não será compartilhada (você pode mudar isso em Segurança e privacidade).'
        : eu.condicao ? `Seu endereço e sua condição ("${eu.condicao}") serão enviados ao profissional.`
        : 'Seu endereço será enviado ao profissional. Você pode informar uma condição (alergia, acessibilidade…) no seu perfil para ele se preparar.';
    }else local = localDoPro(S.pro) || 'Local a combinar com o profissional';
  }
  $('sLocal').innerHTML = esc(local) + (!dom ? linkMapa(localDoPro(S.pro)) : '');
  $('sAviso').textContent = aviso; $('sAviso').hidden = !aviso;
  const valorSv = sv ? (rem ? +sv.precoBase : precoDe(S.pro, sv).valor) : 0;
  const total = sv ? dinheiro(valorSv + (dom ? taxaDe(S.pro) : 0)) : '—';
  $('sTotal').textContent = total; $('sTotal2').textContent = total;
  $('btnConfirmar').textContent = S.remarcando ? 'Confirmar remarcação' : (painelBarber() === 'p-agenda' ? 'Confirmar agendamento' : 'Escolher dia e horário');
}
// troca entre "Na barbearia" e "Em casa": cada modo tem os seus próprios dias e horários
function escolherModo(modo){
  if(S.remarcando) return;
  const dom = modo === 'casa';
  if(dom === !!S.sel.dom) return;
  if(dom && !(S.pro && S.pro.atendeDomicilio)) return;
  S.sel.dom = dom; S.sel.hora = null;
  S.sel.dia = primeiroDiaLivre();
  if(S.sel.dia){ const d = parseYmd(S.sel.dia); S.calRef = new Date(d.getFullYear(), d.getMonth(), 1); }
  renderBarber();
  return carregarSlots();
}

const enderecoTexto = p => `${p.logradouroResidencia}${p.complementoResidencia ? ' - ' + p.complementoResidencia : ''}, ${p.bairroResidencia}${p.cidadeResidencia ? ', ' + p.cidadeResidencia : ''} — CEP ${p.cepResi}`;
// endereço da barbearia (o que o cliente vê para saber onde ir)
const enderecoBarbearia = b => !b ? '' : [
  [b.logradouro, b.complemento].filter(Boolean).join(' - '), b.bairro,
  b.cidade ? b.cidade + (b.estado ? '/' + b.estado : '') : '', b.cep ? 'CEP ' + b.cep : ''
].filter(Boolean).join(', ');
const barbeariaDe = p => (p && p.barbeariaId && S.barbearias[p.barbeariaId]) || null;
// "Nome da barbearia — rua, bairro, cidade" ou '' se o profissional não cadastrou local
function localDoPro(p){
  const b = barbeariaDe(p); if(!b) return '';
  const e = enderecoBarbearia(b);
  return e ? `${b.nome} — ${e}` : b.nome || '';
}
const urlMapa = txt => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(txt);
const linkMapa = txt => txt ? ` <a class="maplink" target="_blank" rel="noopener" href="${esc(urlMapa(txt))}">Ver no mapa</a>` : '';

/* ---- destaques: novidades e promoções ---- */
const hojeStr = () => ymd(new Date());
const promoVigente = pr => !!pr && pr.ativa !== false && (!pr.validaAte || pr.validaAte >= hojeStr());
// melhor desconto vigente do profissional para o serviço (promoção sem serviço vale para todos)
function promoPara(pro, sv){
  if(!pro || !sv) return null;
  return S.promos.filter(pr => pr.profissionalId === pro.id && pr.tipo === 'PROMOCAO' && promoVigente(pr) && +pr.desconto > 0 && (!pr.servicoId || pr.servicoId === sv.id))
    .sort((a, b) => b.desconto - a.desconto)[0] || null;
}
const arred2 = n => Math.round(n * 100) / 100;
function precoDe(pro, sv){
  const base = +sv.precoBase, pr = promoPara(pro, sv);
  return pr ? { base, desconto: +pr.desconto, valor: arred2(base * (100 - pr.desconto) / 100), promo: pr } : { base, desconto: 0, valor: base, promo: null };
}
const dataBr = s => { const [y, m, d] = s.split('-'); return `${d}/${m}`; };

// blocos que o agendamento ocupa hoje, calculados pelos dados dele (não dependem de consulta)
function blocosAtuais(a){
  const sv = servicoPorId(a.servicoId);
  return new Set(slotIds(a.profissionalId, a.data, a.horario, sv ? sv.duracaoMin : SLOT_MIN));
}
async function slotsDoAgendamento(id){
  const snap = await FB.getDocs(FB.query(FB.collection(db, 'horariosOcupados'), FB.where('agendamentoId', '==', id)));
  return snap.docs.map(d => d.id);
}

function falhaReserva(e){
  console.error(e);
  if(e && e.code === 'permission-denied'){
    toast('Não foi possível reservar. Talvez outra pessoa tenha acabado de ocupar esse horário — atualizamos a lista.', 4200);
    return carregarSlots();
  }
  throw e;
}

// Cria o agendamento, os blocos ocupados e as notificações em um único lote (tudo ou nada).
// Usada pela tela de agenda e pelo assistente. Se falhar, lança o erro do Firestore
// (permission-denied = outra pessoa acabou de ocupar o horário).
async function reservar({ pro, sv, dia, hora, dom }){
  const pid = pro.id, uid = S.user.uid, preco = precoDe(pro, sv);
  const ref = FB.doc(FB.collection(db, 'agendamentos'));
  const dados = {
    localAtendimento: dom ? 'DOMICILIO' : 'BARBEARIA',
    clienteId: uid, clienteNome: S.perfil.nome,
    data: dia, horario: hora,
    profissionalId: pid, servicoId: sv.id, agendaId: pid,
    status: 'PENDENTE', criadoEm: FB.serverTimestamp(),
    // cópia do que foi contratado: o faturamento do profissional não muda se ele editar o preço depois
    servicoNome: sv.nome, duracaoMin: +sv.duracaoMin, valorServico: preco.valor,
    valorDeslocamento: dom ? taxaDe(pro) : 0, valorTotal: preco.valor + (dom ? taxaDe(pro) : 0)
  };
  if(preco.promo){ dados.precoOriginal = preco.base; dados.desconto = preco.desconto; dados.promocaoId = preco.promo.id; dados.promocaoTitulo = preco.promo.titulo; }
  if(dom){
    dados.enderecoCliente = enderecoTexto(S.perfil);
    // o profissional precisa saber a condição do cliente para se preparar para o atendimento em casa
    dados.condicaoCliente = consentOk('condicao') ? String(S.perfil.condicao || '').slice(0, 200) : '';
  }else{
    dados.enderecoLocal = localDoPro(pro) || 'Local a combinar com o profissional';
  }
  const batch = FB.writeBatch(db);
  batch.set(ref, dados);
  slotIds(pid, dia, hora, sv.duracaoMin).forEach(id =>
    batch.set(FB.doc(db, 'horariosOcupados', id), { profissionalId: pid, clienteId: uid, agendamentoId: ref.id }));
  const quando = `${dataCurta(dia)} às ${hora}`;
  addNotif(batch, uid, ref.id, 'AGENDAMENTO', `Horário solicitado: ${sv.nome} com ${pro.nome}, ${quando}. Aguarde a confirmação.`);
  addNotif(batch, pid, ref.id, 'AGENDAMENTO', `Novo agendamento de ${S.perfil.nome}: ${sv.nome}, ${quando}.`);
  await batch.commit();
  return ref.id;
}

async function confirmar(){
  if(S.remarcando) return confirmarRemarcacao();
  const sv = servicoSel();
  if(!sv) return toast('Escolha um serviço.');
  if(painelBarber() !== 'p-agenda'){ irAba('p-agenda'); return; }   // 1º serviço, 2º dia e horário
  if(!S.sel.dia || !S.sel.hora) return toast('Escolha o dia e o horário.');
  if(!S.perfil.perfilCompleto){ toast('Complete seu perfil antes de agendar.'); return show('s-me'); }
  await comBotao('btnConfirmar', async () => {
    try{ await reservar({ pro: S.pro, sv, dia: S.sel.dia, hora: S.sel.hora, dom: !!(S.sel.dom && S.pro.atendeDomicilio) }); }
    catch(e){ return falhaReserva(e); }
    toast('Agendamento solicitado ✓');
    show('s-meus');
  });
}

async function confirmarRemarcacao(){
  const a = S.agds.find(x => x.id === (S.remarcando && S.remarcando.id)) || S.remarcando;   // sempre a versão mais recente
  if(!S.sel.dia || !S.sel.hora) return toast('Escolha o novo dia e horário.');
  await comBotao('btnConfirmar', async () => {
    const sv = servicoPorId(a.servicoId), dur = sv ? sv.duracaoMin : SLOT_MIN;
    const pid = a.profissionalId, uid = S.user.uid;
    // blocos antigos: os que a consulta acha + os calculados pelo próprio horário (só vale se o documento existir de fato)
    const porConsulta = await slotsDoAgendamento(a.id);
    const calculados = [...blocosAtuais(a)].filter(id => !porConsulta.includes(id));
    const existentes = [];
    for(const id of calculados){
      const sn = await FB.getDoc(FB.doc(db, 'horariosOcupados', id)).catch(() => null);
      if(sn && sn.exists() && sn.data().clienteId === uid) existentes.push(id);
    }
    const antigos = [...porConsulta, ...existentes];
    const novos = slotIds(pid, S.sel.dia, S.sel.hora, dur);
    const batch = FB.writeBatch(db);
    batch.update(FB.doc(db, 'agendamentos', a.id), { data: S.sel.dia, horario: S.sel.hora, status: 'REMARCADO' });
    antigos.filter(id => !novos.includes(id)).forEach(id => batch.delete(FB.doc(db, 'horariosOcupados', id)));
    novos.filter(id => !antigos.includes(id)).forEach(id =>
      batch.set(FB.doc(db, 'horariosOcupados', id), { profissionalId: pid, clienteId: uid, agendamentoId: a.id }));
    const quando = `${dataCurta(S.sel.dia)} às ${S.sel.hora}`;
    addNotif(batch, uid, a.id, 'REMARCACAO', `Você remarcou para ${quando}. Aguarde a confirmação.`);
    addNotif(batch, pid, a.id, 'REMARCACAO', `${S.perfil.nome} remarcou o horário para ${quando}.`);
    try{ await batch.commit(); }catch(e){ return falhaReserva(e); }
    S.remarcando = null;
    toast('Horário remarcado ✓');
    show('s-meus');
  });
}

// o profissional toca em "Iniciar" quando começa o atendimento: serve para medir o tempo gasto de verdade
async function iniciarAtendimento(id){
  const a = S.agds.find(x => x.id === id); if(!a || a.iniciadoEm) return;
  await FB.updateDoc(FB.doc(db, 'agendamentos', id), { iniciadoEm: Date.now() });
  toast('Atendimento iniciado ⏱');
}

// quem = 'cliente' | 'pro'
async function mudarStatus(id, status, quem){
  const a = S.agds.find(x => x.id === id); if(!a) return;
  const sv = servicoPorId(a.servicoId), quando = `${dataCurta(a.data)} às ${a.horario}`;
  const batch = FB.writeBatch(db);
  const upd = { status };
  if(status === 'CONCLUIDO'){
    const fim = Date.now();
    upd.concluidoEm = fim;
    if(a.iniciadoEm) upd.duracaoReal = Math.max(1, Math.round((fim - a.iniciadoEm) / 60000));   // minutos de verdade, do "Iniciar" ao "Concluir"
  }
  batch.update(FB.doc(db, 'agendamentos', id), upd);
  if(status === 'CANCELADO')
    (await slotsDoAgendamento(id)).forEach(sid => batch.delete(FB.doc(db, 'horariosOcupados', sid)));
  if(quem === 'pro'){
    const msg = {
      CONFIRMADO: `Seu horário foi confirmado: ${sv ? sv.nome : 'serviço'}, ${quando}.`,
      CANCELADO: `O profissional cancelou seu horário de ${quando}.`,
      CONCLUIDO: 'Atendimento concluído. Obrigado pela visita!'
    }[status];
    if(msg) addNotif(batch, a.clienteId, id, status, msg);
  }else if(status === 'CANCELADO'){
    addNotif(batch, a.profissionalId, id, status, `${a.clienteNome || 'O cliente'} cancelou o horário de ${quando}.`);
  }
  await batch.commit();
  toast(status === 'CONFIRMADO' ? 'Horário confirmado ✓' : status === 'CONCLUIDO' ? 'Atendimento concluído ✓' : 'Horário cancelado');
}

/* ---------------------------------------------------------------------
   CLIENTE — perfil
   --------------------------------------------------------------------- */
function fillMe(){
  const p = S.perfil || {};
  $('meBanner').hidden = !!p.perfilCompleto;
  $('meNome').textContent = p.nome || 'Seu perfil';
  setAvatar($('meAvatar'), p); setCover($('meCover'), S.bannerProprio);
  $('meEmail').textContent = (S.user && S.user.email) || '';
  const m = { 'me-nome':'nome', 'me-tel':'telefone', 'me-cpf':'cpf', 'me-cnpj':'cnpj', 'me-rua':'logradouroResidencia',
              'me-cep':'cepResi', 'me-cidade':'cidadeResidencia', 'me-bairro':'bairroResidencia', 'me-comp':'complementoResidencia', 'me-cond':'condicao' };
  Object.entries(m).forEach(([id, k]) => $(id).value = p[k] || '');
  $('me-uf').value = p.estado || '';
  const i = $('me-cepInfo'); if(i){ i.textContent = ''; i.className = 'hint cep-info'; }
  renderPushSwitch();
}
async function salvarPerfil(){
  const d = {
    nome: val('me-nome'), telefone: val('me-tel'), estado: $('me-uf').value, cpf: val('me-cpf'), cnpj: val('me-cnpj'),
    logradouroResidencia: val('me-rua'), bairroResidencia: val('me-bairro'), cepResi: val('me-cep'),
    complementoResidencia: val('me-comp'), cidadeResidencia: val('me-cidade'), condicao: val('me-cond').slice(0, 200)
  };
  if(d.telefone && !SG.telValido(d.telefone)) return toast('Telefone inválido. Use DDD + número, ex.: (11) 91234-5678.', 3800);
  if(d.cpf && !SG.cpfValido(d.cpf)) return toast('CPF inválido. Confira os números.', 3800);
  if(d.cnpj && !SG.cnpjValido(d.cnpj)) return toast('CNPJ inválido. Confira os números.', 3800);
  const completo = !!(d.nome && d.telefone && d.estado && (d.cpf || d.cnpj) && d.logradouroResidencia && d.bairroResidencia && d.cepResi && d.cidadeResidencia);
  if(d.cepResi || d.cidadeResidencia){
    if(!cepValido(d.cepResi)) return toast('O CEP precisa ter 8 números.');
    if(!d.cidadeResidencia) return toast('Informe a cidade do seu CEP.');
  }
  await comBotao('meBtn', async () => {
    if(d.cepResi){ const v = await validarEndereco(d.cepResi, d.cidadeResidencia, d.estado); if(!v.ok) return toast(v.erro, 4200); }
    const antes = !!S.perfil.perfilCompleto;
    let geo = {};
    if(cepValido(d.cepResi) && (soDigitos(d.cepResi) !== soDigitos(S.perfil.cepResi) || !numOk(S.perfil.lat))){
      const pos = await geocodificarCep(d.cepResi);
      geo = pos ? { lat: pos.lat, lng: pos.lng } : { lat: null, lng: null };
      if(!pos && consentOk('localizacao')) toast('Não consegui localizar esse CEP. Confira o número para ver a distância dos barbeiros.', 4200);
    }
    await FB.updateDoc(FB.doc(db, 'clientes', S.user.uid), { ...d, ...geo, perfilCompleto: completo });
    S.perfil = { ...S.perfil, ...d, ...geo, perfilCompleto: completo };
    fillMe();
    if(completo){ toast('Perfil salvo ✓'); if(!antes) show('s-home'); }
    else toast('Perfil salvo. Falta preencher os campos obrigatórios (*) para poder agendar.', 4200);
  });
}

/* ---------------------------------------------------------------------
   PROFISSIONAL — agenda
   --------------------------------------------------------------------- */
function cardAgdPro(a){
  const sv = servicoPorId(a.servicoId), st = STATUS[a.status] || { t: a.status, c: '' };
  const comeco = `${a.data} ${a.horario}` <= agoraStr();
  let acts = '';
  if(a.status === 'PENDENTE' || a.status === 'REMARCADO')
    acts = `<button class="btn btn-gold btn-sm" data-act="pConfirmar" data-id="${esc(a.id)}">Confirmar</button><button class="btn btn-danger btn-sm" data-act="pCancelar" data-id="${esc(a.id)}">Recusar</button>`;
  else if(a.status === 'CONFIRMADO')
    acts = (comeco && !a.iniciadoEm ? `<button class="btn btn-line btn-sm" data-act="pIniciar" data-id="${esc(a.id)}">Iniciar</button>` : '')
         + (comeco ? `<button class="btn btn-gold btn-sm" data-act="pConcluir" data-id="${esc(a.id)}">Concluir</button>` : '')
         + `<button class="btn btn-danger btn-sm" data-act="pCancelar" data-id="${esc(a.id)}">Cancelar</button>`;
  return `<div class="acard"><div class="top"><span class="ic">${ICON_CAL}</span>
    <span class="tx"><b>${esc(a.clienteNome || 'Cliente')}</b>
    <span>${esc(sv ? sv.nome : 'Serviço removido')} · ${esc(dataCurta(a.data))} · ${esc(a.horario)}</span>
    ${a.localAtendimento === 'DOMICILIO'
      ? `<span>🏠 Em casa: ${esc(a.enderecoCliente || 'endereço não informado')}${linkMapa(a.enderecoCliente)}</span>
         <span class="cond">⚕ Condição do cliente: <b>${a.condicaoCliente ? esc(a.condicaoCliente) : 'nenhuma informada'}</b></span>`
      : `<span>📍 Na barbearia${a.enderecoLocal ? ': ' + esc(a.enderecoLocal) : ''}</span>`}</span>
    <span class="st ${st.c}">${a.iniciadoEm && a.status === 'CONFIRMADO' ? 'em atendimento' : st.t}</span></div>${acts ? `<div class="acts">${acts}</div>` : ''}</div>`;
}

function renderPAgenda(){
  renderBell();
  const hoje = ymd(new Date());
  const prox = S.agds.filter(proximo), ant = S.agds.filter(a => !proximo(a)).reverse();
  $('pMetrics').innerHTML =
    `<div class="metric"><span>Hoje</span><b>${S.agds.filter(a => a.data === hoje && ativo(a)).length}</b><small>atendimentos</small></div>
     <div class="metric"><span>Aguardando</span><b>${prox.filter(a => a.status === 'PENDENTE' || a.status === 'REMARCADO').length}</b><small>sua confirmação</small></div>
     <div class="metric"><span>Próximos</span><b>${prox.length}</b><small>na agenda</small></div>
     <div class="metric"><span>Concluídos</span><b>${S.agds.filter(a => a.status === 'CONCLUIDO').length}</b><small>no total</small></div>`;
  $('pProx').innerHTML = prox.length ? prox.map(cardAgdPro).join('') : '<div class="empty">Nenhum atendimento marcado.</div>';
  $('pAnt').innerHTML = ant.length ? ant.map(cardAgdPro).join('') : '<div class="empty">Nada por aqui ainda.</div>';
}

/* ---------------------------------------------------------------------
   PROFISSIONAL — resultados (BI): serviço mais pedido, horários de pico, tempo médio e faturamento
   Tudo calculado no aparelho a partir dos agendamentos do próprio profissional.
   --------------------------------------------------------------------- */
const PERIODOS = { dia: { n: 'hoje', dias: 1 }, semana: { n: 'últimos 7 dias', dias: 7 }, mes: { n: 'últimos 30 dias', dias: 30 } };
const somar = (l, f) => l.reduce((t, x) => t + f(x), 0);
const media = l => l.length ? somar(l, x => x) / l.length : 0;
const minTxt = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? pad(Math.round(m % 60)) : ''}` : `${Math.round(m)} min`;
const valorAgd = a => {
  if(Number.isFinite(+a.valorTotal) && a.valorTotal !== null) return +a.valorTotal;
  const sv = servicoPorId(a.servicoId);                       // agendamentos antigos (sem cópia do valor)
  return sv ? +sv.precoBase + (a.localAtendimento === 'DOMICILIO' ? taxaDe(S.perfil) : 0) : 0;
};
const nomeSvcAgd = a => a.servicoNome || (servicoPorId(a.servicoId) || {}).nome || 'Serviço removido';
const duracaoPlan = a => Number.isFinite(+a.duracaoMin) && a.duracaoMin ? +a.duracaoMin : ((servicoPorId(a.servicoId) || {}).duracaoMin || SLOT_MIN);

function calcularBI(periodo, lista = S.agds, agora = new Date()){
  const hoje = ymd(agora), n = PERIODOS[periodo].dias;
  const ini = ymd(new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - (n - 1)));
  const no = a => a.data >= ini && a.data <= hoje;
  const demanda = lista.filter(a => no(a) && a.status !== 'CANCELADO');     // pedidos (não cancelados)
  const feitos = lista.filter(a => no(a) && a.status === 'CONCLUIDO');
  const fat = somar(feitos, valorAgd);
  const agoraTxt = `${hoje} ${pad(agora.getHours())}:${pad(agora.getMinutes())}`;
  const previsto = lista.filter(a => ['PENDENTE', 'CONFIRMADO', 'REMARCADO'].includes(a.status) && `${a.data} ${a.horario}` >= agoraTxt);

  const porSvc = {};
  demanda.forEach(a => { (porSvc[nomeSvcAgd(a)] ||= []).push(a); });
  const servicos = Object.entries(porSvc).map(([nome, l]) => {
    const fe = l.filter(a => a.status === 'CONCLUIDO'), reais = fe.filter(a => a.duracaoReal).map(a => +a.duracaoReal);
    return { nome, pedidos: l.length, faturou: somar(fe, valorAgd),
      tempo: reais.length ? media(reais) : media(l.map(duracaoPlan)), tempoReal: reais.length > 0 };
  }).sort((a, b) => b.pedidos - a.pedidos || b.faturou - a.faturou);

  const horas = {}; demanda.forEach(a => { const h = parseInt(a.horario, 10); horas[h] = (horas[h] || 0) + 1; });
  const dow = Array(7).fill(0); demanda.forEach(a => { dow[parseYmd(a.data).getDay()]++; });
  const picos = Object.entries(horas).map(([h, c]) => ({ h: +h, c })).sort((a, b) => b.c - a.c || a.h - b.h);

  return { ini, hoje, demanda, feitos, fat, ticket: feitos.length ? fat / feitos.length : 0, previstoValor: somar(previsto, valorAgd), previstoQtd: previsto.length,
    fatCasa: somar(feitos.filter(a => a.localAtendimento === 'DOMICILIO'), valorAgd), fatLoja: somar(feitos.filter(a => a.localAtendimento !== 'DOMICILIO'), valorAgd),
    servicos, horas, dow, picos };
}

function renderBI(){
  renderBell();
  const per = S.biPeriodo, r = calcularBI(per);
  document.querySelectorAll('#biChips .chip').forEach(c => c.classList.toggle('on', c.dataset.id === per));
  $('biSub').textContent = `${per === 'dia' ? 'Resumo de hoje' : 'Resumo dos ' + PERIODOS[per].n}, a partir dos seus agendamentos.`;
  let h = '';
  const top = r.servicos[0];
  h += `<div class="metrics" style="margin-top:16px">
    <div class="metric"><span>Faturamento</span><b>${dinheiro(r.fat)}</b><small>${r.feitos.length} atendimento${r.feitos.length === 1 ? '' : 's'} concluído${r.feitos.length === 1 ? '' : 's'}</small></div>
    <div class="metric"><span>Ticket médio</span><b>${dinheiro(Math.round(r.ticket * 100) / 100)}</b><small>por atendimento</small></div>
    <div class="metric"><span>A receber</span><b>${dinheiro(r.previstoValor)}</b><small>${r.previstoQtd} agendado${r.previstoQtd === 1 ? '' : 's'} pela frente</small></div>
    <div class="metric"><span>Pedidos</span><b>${r.demanda.length}</b><small>sem cancelados</small></div>
  </div>`;
  if(!r.demanda.length){
    h += '<div class="empty" style="margin-top:18px">Sem atendimentos em ' + PERIODOS[per].n + '.<br>Quando houver agendamentos, os números aparecem aqui.</div>';
    $('biBody').innerHTML = h; return;
  }
  h += `<div class="destaque-bi" style="margin-top:14px">✂️ Mais pedido ${per === 'dia' ? 'hoje' : 'nos ' + PERIODOS[per].n}: <b>${esc(top.nome)}</b> (${top.pedidos} ${top.pedidos === 1 ? 'vez' : 'vezes'}).`
    + (r.picos.length ? `<br>⏰ Horário de pico: <b>${pad(r.picos[0].h)}h</b> (${r.picos[0].c} ${r.picos[0].c === 1 ? 'pedido' : 'pedidos'}).` : '') + '</div>';

  const max = Math.max(...r.servicos.map(x => x.pedidos));
  h += '<div class="group-title">Serviços mais pedidos</div><div class="card"><div class="bars">'
    + r.servicos.slice(0, 6).map(x => `<div class="brow"><span class="nm">${esc(x.nome)}</span><span class="btrack"><i style="width:${Math.max(6, Math.round(x.pedidos / max * 100))}%"></i></span><span class="vl">${x.pedidos}×</span></div>`).join('')
    + '</div></div>';

  h += '<div class="group-title">Tempo médio e faturamento por serviço</div><div class="card">'
    + r.servicos.map(x => `<div class="srow" style="display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:13px">
        <span style="min-width:0"><b style="font-weight:500">${esc(x.nome)}</b><br><span class="tiny muted">${minTxt(x.tempo)} em média · ${x.tempoReal ? 'tempo real medido' : 'duração prevista'}</span></span>
        <b style="color:var(--gold);font-weight:600;white-space:nowrap">${dinheiro(x.faturou)}</b></div>`).join('')
    + '<p class="sub-note">O tempo real aparece quando você toca em "Iniciar" e depois em "Concluir" no atendimento. Sem isso, usamos a duração cadastrada do serviço. O faturamento soma só atendimentos concluídos.</p></div>';

  const hs = Object.keys(r.horas).map(Number), de = Math.min(...hs), ate = Math.max(...hs), mx = Math.max(...Object.values(r.horas));
  let cols = '';
  for(let x = de; x <= ate; x++){
    const c = r.horas[x] || 0;
    cols += `<div class="col ${c === mx ? 'top' : ''}">${c ? `<em>${c}</em>` : ''}<i style="height:${c ? Math.max(8, Math.round(c / mx * 90)) : 2}%"></i><span>${pad(x)}h</span></div>`;
  }
  h += `<div class="group-title">Horários de pico</div><div class="card"><div class="hist">${cols}</div>
    <p class="sub-note">Mais cheios: ${r.picos.slice(0, 3).map(x => `${pad(x.h)}h (${x.c})`).join(' · ')}</p></div>`;

  if(per !== 'dia'){
    const mxd = Math.max(...r.dow, 1);
    h += `<div class="group-title">Dias da semana</div><div class="card"><div class="hist">${ORDEM_SEMANA.map(i => `<div class="col ${r.dow[i] === mxd && mxd > 0 ? 'top' : ''}">${r.dow[i] ? `<em>${r.dow[i]}</em>` : ''}<i style="height:${r.dow[i] ? Math.max(8, Math.round(r.dow[i] / mxd * 90)) : 2}%"></i><span>${DIAS_ABREV[i]}</span></div>`).join('')}</div></div>`;
  }
  if(r.fat > 0) h += `<div class="group-title">Onde você faturou</div><div class="card"><div class="bars">
    <div class="brow"><span class="nm">Na barbearia</span><span class="btrack"><i style="width:${Math.round(r.fatLoja / r.fat * 100)}%"></i></span><span class="vl">${dinheiro(r.fatLoja)}</span></div>
    <div class="brow"><span class="nm">Em casa</span><span class="btrack"><i style="width:${Math.round(r.fatCasa / r.fat * 100)}%"></i></span><span class="vl">${dinheiro(r.fatCasa)}</span></div></div></div>`;
  $('biBody').innerHTML = h;
}

/* ---------------------------------------------------------------------
   PROFISSIONAL — painel (perfil, serviços, horários, barbearia)
   --------------------------------------------------------------------- */
function fillPro(){
  const p = S.perfil || {}, v = S.privado || {};
  setAvatar($('prAvatar'), p); setCover($('prCover'), S.bannerProprio); $('prNome').textContent = p.nome || '—'; $('prSub').textContent = subPro(p);
  $('pr-nome').value = p.nome || ''; $('pr-tel').value = p.telefone || ''; $('pr-uf').value = p.estado || '';
  $('pr-sobre').value = p.sobre || '';
  $('pr-dom').classList.toggle('on', !!p.atendeDomicilio);
  $('prDomTxt').textContent = 'Defina a taxa, os dias e os horários em casa';
  $('pr-taxa').value = String(taxaDe(p)).replace('.', ',');
  const m = { 'pr-cpf':'cpf', 'pr-cnpj':'cnpj', 'pr-rua':'logradouroResidencia', 'pr-cep':'cepResi', 'pr-cidade':'cidadeResidencia', 'pr-bairro':'bairroResidencia', 'pr-comp':'complementoResidencia' };
  Object.entries(m).forEach(([id, k]) => $(id).value = v[k] || '');
  renderHoras(); renderHorasDom(); domProToggle(); renderServicosPro();
  $('pr-barb').innerHTML = '<option value="">Nenhuma (autônomo)</option>'
    + Object.values(S.barbearias).filter(b => b.donoId === S.user.uid).sort((a,b) => (a.nome||'').localeCompare(b.nome||'')).map(b => `<option value="${esc(b.id)}">${esc(b.nome)}</option>`).join('')
    + '<option value="__nova">+ Cadastrar nova barbearia</option>';
  $('pr-barb').value = (p.barbeariaId && S.barbearias[p.barbeariaId]) ? p.barbeariaId : '';
  barbSelecionada();
  ['pr-cepInfo','bb-cepInfo'].forEach(id => { const i = $(id); if(i){ i.textContent = ''; i.className = 'hint cep-info'; } });
  renderPromosPro(); if(!S.promoEdit) limparPromo(); renderPushSwitch();
}

function renderHoras(){ desenharHoras('prHoras', S.horariosPro, HORARIOS_PADRAO); }
function renderHorasDom(){ desenharHoras('prHorasDom', S.horariosDom, HORARIOS_DOM_PADRAO); }
function domProToggle(){ $('prDomBox').hidden = !$('pr-dom').classList.contains('on'); }
function desenharHoras(boxId, dados, padrao){
  $(boxId).innerHTML = ORDEM_SEMANA.map(i => {
    const k = DIAS[i], h = dados[k] || padrao[k];
    return `<div class="hour ${h.aberto ? '' : 'fechado'}" data-dia="${k}"><span class="d">${DIAS_NOME[i]}</span>
      <div class="switch ${h.aberto ? 'on' : ''}" data-act="horaSw" aria-label="${DIAS_NOME[i]} aberto"></div>
      <input type="time" value="${esc(h.inicio)}" aria-label="Abre"><span class="sep">até</span><input type="time" value="${esc(h.fim)}" aria-label="Fecha"></div>`;
  }).join('');
}
function coletarHoras(boxId = 'prHoras', rotulo = ''){
  const out = {};
  for(const row of document.querySelectorAll('#' + boxId + ' .hour')){
    const [a, b] = row.querySelectorAll('input'), aberto = row.querySelector('.switch').classList.contains('on');
    if(aberto && (!a.value || !b.value || toMin(a.value) >= toMin(b.value)))
      throw new Error(`Confira o horário ${rotulo}de ${DIAS_NOME[DIAS.indexOf(row.dataset.dia)]}: a abertura deve ser antes do fechamento.`);
    out[row.dataset.dia] = { aberto, inicio: a.value || '09:00', fim: b.value || '18:00' };
  }
  return out;
}

// Em casa e na barbearia não podem se sobrepor no mesmo dia (o profissional não está nos dois lugares ao mesmo tempo)
function conflitoHorarios(loja, casa){
  for(const i of ORDEM_SEMANA){
    const k = DIAS[i], a = loja[k], b = casa[k];
    if(a && b && a.aberto && b.aberto && toMin(a.inicio) < toMin(b.fim) && toMin(b.inicio) < toMin(a.fim))
      return `${DIAS_NOME[i]}: o atendimento em casa (${b.inicio} às ${b.fim}) se sobrepõe ao da barbearia (${a.inicio} às ${a.fim}). Ajuste um dos dois.`;
  }
  return '';
}

function barbSelecionada(){
  const v = $('pr-barb').value, uid = S.user && S.user.uid, b = S.barbearias[v];
  const meu = v === '__nova' || (b && b.donoId === uid);
  $('barbForm').hidden = !meu;
  if(v === '__nova'){ ['bb-nome','bb-cnpj','bb-cep','bb-cidade','bb-rua','bb-bairro','bb-comp'].forEach(i => $(i).value = ''); }
  else if(meu){ $('bb-nome').value = b.nome || ''; $('bb-cnpj').value = b.cnpj || ''; $('bb-cep').value = b.cep || ''; $('bb-cidade').value = b.cidade || ''; $('bb-rua').value = b.logradouro || ''; $('bb-bairro').value = b.bairro || ''; $('bb-comp').value = b.complemento || ''; }
  $('barbHint').textContent = v === '__nova' ? 'Você será o responsável por esta barbearia e poderá editar os dados dela.'
    : meu ? 'Você é o responsável por esta barbearia.'
    : 'Sem barbearia: você aparece como profissional independente.';
}

async function salvarPro(){
  const uid = S.user.uid;
  const d = { nome: val('pr-nome'), telefone: val('pr-tel'), estado: $('pr-uf').value, sobre: val('pr-sobre').slice(0, 280), atendeDomicilio: $('pr-dom').classList.contains('on') };
  const priv = { cpf: val('pr-cpf'), cnpj: val('pr-cnpj'), logradouroResidencia: val('pr-rua'), cepResi: val('pr-cep'), cidadeResidencia: val('pr-cidade'), bairroResidencia: val('pr-bairro'), complementoResidencia: val('pr-comp') };
  if(!d.nome || !d.telefone || !d.estado) return toast('Preencha nome, telefone e estado.');
  { const e = erroDocs({ cpf: priv.cpf, cnpj: priv.cnpj, telefone: d.telefone }); if(e) return toast(e, 4000); }
  if(!priv.logradouroResidencia || !priv.cepResi || !priv.bairroResidencia || !priv.cidadeResidencia) return toast('Preencha o endereço (CEP, cidade, rua e bairro).');
  let horarios, horariosDomicilio;
  try{ horarios = coletarHoras('prHoras', 'da barbearia '); horariosDomicilio = coletarHoras('prHorasDom', 'em casa '); }catch(e){ return toast(e.message, 3800); }
  const taxaTxt = val('pr-taxa').replace(',', '.'), taxa = taxaTxt === '' ? TAXA_DOMICILIO : parseFloat(taxaTxt);
  if(d.atendeDomicilio){
    if(!(taxa >= 0 && taxa <= 1000)) return toast('Informe a taxa de deslocamento (use 0 se não cobrar).');
    const c = conflitoHorarios(horarios, horariosDomicilio);
    if(c) return toast(c, 5200);
    if(!ORDEM_SEMANA.some(i => horariosDomicilio[DIAS[i]].aberto)) return toast('Marque pelo menos um dia de atendimento em casa.', 3800);
  }
  d.taxaDomicilio = Number.isFinite(taxa) && taxa >= 0 ? taxa : TAXA_DOMICILIO;
  const sel = $('pr-barb').value;
  const criaOuEdita = sel === '__nova' || (S.barbearias[sel] && S.barbearias[sel].donoId === uid);
  if(criaOuEdita && (!val('bb-nome') || !val('bb-cnpj'))) return toast('Informe o nome e o CNPJ da barbearia.');
  if(criaOuEdita && !SG.cnpjValido(val('bb-cnpj'))) return toast('CNPJ da barbearia inválido. Confira os números.', 3800);
  if(criaOuEdita && (!val('bb-rua') || !val('bb-bairro') || !val('bb-cep') || !val('bb-cidade'))) return toast('Preencha o endereço da barbearia (CEP, cidade, rua e bairro): é o que o cliente vê para saber onde ir.', 4600);

  await comBotao('prBtn', async () => {
    const vp = await validarEndereco(priv.cepResi, priv.cidadeResidencia, d.estado);
    if(!vp.ok) return toast('Seu endereço: ' + vp.erro, 4600);
    let vb = null;
    if(criaOuEdita){ vb = await validarEndereco(val('bb-cep'), val('bb-cidade'), ''); if(!vb.ok) return toast('Barbearia: ' + vb.erro, 4600); }
    const batch = FB.writeBatch(db);
    let barbeariaId = sel && sel !== '__nova' ? sel : null, novaB = null;
    if(criaOuEdita){
      const ref = sel === '__nova' ? FB.doc(FB.collection(db, 'barbearias')) : FB.doc(db, 'barbearias', sel);
      novaB = { nome: val('bb-nome'), cnpj: val('bb-cnpj'), logradouro: val('bb-rua'), bairro: val('bb-bairro'), complemento: val('bb-comp'),
                cep: val('bb-cep'), cidade: vb.dados.cidade, estado: vb.dados.uf, donoId: uid };
      batch.set(ref, novaB);
      barbeariaId = ref.id; novaB.id = ref.id;
    }
    let geo = {};
    const cepMudou = soDigitos(priv.cepResi) !== soDigitos((S.privado || {}).cepResi);
    if(cepMudou || !numOk(S.perfil.lat)){
      const pos = await geocodificarCep(priv.cepResi);
      geo = pos ? { lat: aprox(pos.lat), lng: aprox(pos.lng) } : { lat: null, lng: null };
      if(!pos && consentOk('localizacao')) toast('Não consegui localizar esse CEP. A distância até você não será mostrada aos clientes.', 4200);
    }
    batch.set(FB.doc(db, 'profissionais', uid), { ...d, ...geo, barbeariaId }, { merge: true });
    batch.set(FB.doc(db, 'profissionais', uid, 'privado', 'dados'), priv);
    batch.set(FB.doc(db, 'agendas', uid), { profissionalId: uid, horarios, horariosDomicilio }, { merge: true });
    await batch.commit();
    S.perfil = { ...S.perfil, ...d, ...geo, barbeariaId };
    S.privado = priv; S.horariosPro = horarios; S.horariosDom = horariosDomicilio;
    if(novaB) S.barbearias[novaB.id] = novaB;
    fillPro();
    toast('Alterações salvas ✓');
  });
}

/* serviços do profissional */
function renderServicosPro(){
  const l = [...S.servicos].sort((a,b) => a.nome.localeCompare(b.nome));
  $('prServicos').innerHTML = l.length ? l.map(s =>
    `<div class="svc row"><span class="n"><b>${esc(s.nome)}</b><span>${esc(s.duracaoMin)} min</span></span><span class="p">${dinheiro(s.precoBase)}</span>
     <button class="mini" data-act="editSvc" data-id="${esc(s.id)}" aria-label="Editar">✎</button>
     <button class="mini bad" data-act="delSvc" data-id="${esc(s.id)}" aria-label="Remover">✕</button></div>`).join('')
    : '<div class="empty" style="padding:12px 10px 18px">Nenhum serviço ainda. Cadastre o primeiro abaixo.</div>';
}
function limparServico(){
  S.svEditId = null;
  ['sv-nome','sv-dur','sv-preco'].forEach(i => $(i).value = '');
  $('svTitulo').textContent = 'Novo serviço'; $('svBtn').textContent = 'Adicionar serviço'; $('svCancel').hidden = true;
}
async function salvarServico(){
  const nome = val('sv-nome'), dur = parseInt($('sv-dur').value, 10), preco = parseFloat(String($('sv-preco').value).replace(',', '.'));
  if(!nome) return toast('Informe o nome do serviço.');
  if(!(dur >= 5)) return toast('Informe a duração em minutos (mínimo 5).');
  if(!(preco >= 0)) return toast('Informe o preço.');
  await comBotao('svBtn', async () => {
    const uid = S.user.uid;
    const ref = S.svEditId ? FB.doc(db, 'servicos', S.svEditId) : FB.doc(FB.collection(db, 'servicos'));
    const dados = { profissionalId: uid, nome, duracaoMin: dur, precoBase: preco };
    await FB.setDoc(ref, dados);
    S.servicos = S.servicos.filter(s => s.id !== ref.id).concat([{ id: ref.id, ...dados }]);
    limparServico(); renderServicosPro();
    toast('Serviço salvo ✓');
  });
}
function editarServico(id){
  const s = servicoPorId(id); if(!s) return;
  S.svEditId = id;
  $('sv-nome').value = s.nome; $('sv-dur').value = s.duracaoMin; $('sv-preco').value = s.precoBase;
  $('svTitulo').textContent = 'Editar serviço'; $('svBtn').textContent = 'Salvar serviço'; $('svCancel').hidden = false;
  $('sv-nome').focus();
}
async function removerServico(id){
  const s = servicoPorId(id); if(!s) return;
  if(!confirm(`Remover o serviço "${s.nome}"? Agendamentos antigos continuarão na agenda.`)) return;
  await FB.deleteDoc(FB.doc(db, 'servicos', id));
  S.servicos = S.servicos.filter(x => x.id !== id);
  if(S.svEditId === id) limparServico();
  renderServicosPro();
  toast('Serviço removido');
}

/* ---------------------------------------------------------------------
   FOTO DE PERFIL, BANNER E LOCALIZAÇÃO (cliente e profissional)
   --------------------------------------------------------------------- */
/* destaques do profissional: novidades e promoções que aparecem no Início dos clientes */
function renderPromosPro(){
  const box = $('prPromos'); if(!box) return;
  $('pm-servico').innerHTML = '<option value="">Todos os serviços</option>'
    + S.servicos.filter(x => x.profissionalId === S.user.uid).sort((a,b) => a.nome.localeCompare(b.nome)).map(x => `<option value="${esc(x.id)}">${esc(x.nome)}</option>`).join('');
  box.innerHTML = S.promosPro.length ? S.promosPro.map(pr => {
    const vig = promoVigente(pr), sv = pr.servicoId ? servicoPorId(pr.servicoId) : null;
    return `<div class="acard"><div class="top"><span class="ic">${pr.tipo === 'PROMOCAO' ? '🏷' : '✨'}</span>
      <span class="tx"><b>${esc(pr.titulo)}</b>
      <span>${pr.tipo === 'PROMOCAO' ? `−${esc(pr.desconto)}% · ${sv ? esc(sv.nome) : 'todos os serviços'}` : 'Novidade'} · até ${esc(dataBr(pr.validaAte || hojeStr()))}</span></span>
      <span class="st ${vig ? 'ok' : ''}">${vig ? 'no ar' : 'encerrada'}</span></div>
      <div class="acts"><button class="btn btn-line btn-sm" data-act="editPromo" data-id="${esc(pr.id)}">Editar</button>
      <button class="btn btn-danger btn-sm" data-act="delPromo" data-id="${esc(pr.id)}">Apagar</button></div></div>`;
  }).join('') : '<div class="empty">Você ainda não publicou nenhum destaque.</div>';
  promoTipoToggle();
}
function promoTipoToggle(){ $('pmDescBox').hidden = $('pm-tipo').value !== 'PROMOCAO'; }
function limparPromo(){
  S.promoEdit = null;
  ['pm-titulo','pm-desc','pm-desconto','pm-ate'].forEach(i => $(i).value = '');
  $('pm-tipo').value = 'PROMOCAO'; $('pm-servico').value = '';
  $('pmTitulo').textContent = 'Novo destaque'; $('pmBtn').textContent = 'Publicar destaque'; $('pmCancel').hidden = true;
  const d = new Date(); d.setDate(d.getDate() + 7); $('pm-ate').value = ymd(d);
  promoTipoToggle();
}
function editarPromo(id){
  const pr = S.promosPro.find(x => x.id === id); if(!pr) return;
  S.promoEdit = id;
  $('pm-tipo').value = pr.tipo; $('pm-titulo').value = pr.titulo; $('pm-desc').value = pr.descricao || '';
  $('pm-desconto').value = pr.tipo === 'PROMOCAO' ? String(pr.desconto) : ''; $('pm-servico').value = pr.servicoId || ''; $('pm-ate').value = pr.validaAte || '';
  $('pmTitulo').textContent = 'Editar destaque'; $('pmBtn').textContent = 'Salvar destaque'; $('pmCancel').hidden = false;
  promoTipoToggle();
  $('pm-titulo').scrollIntoView({ block: 'center' });
}
async function salvarPromo(){
  const tipo = $('pm-tipo').value, titulo = val('pm-titulo').slice(0, 60), descricao = val('pm-desc').slice(0, 200);
  const desconto = tipo === 'PROMOCAO' ? parseFloat(val('pm-desconto').replace(',', '.')) : 0, validaAte = $('pm-ate').value;
  if(!titulo) return toast('Dê um título ao destaque.');
  if(tipo === 'PROMOCAO' && !(desconto > 0 && desconto <= 90)) return toast('Informe o desconto em % (de 1 a 90).');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(validaAte) || validaAte < hojeStr()) return toast('Escolha uma data de validade a partir de hoje.');
  const uid = S.user.uid;
  const dados = { profissionalId: uid, tipo, titulo, descricao, desconto: tipo === 'PROMOCAO' ? Math.round(desconto * 100) / 100 : 0,
                  servicoId: tipo === 'PROMOCAO' ? ($('pm-servico').value || null) : null, validaAte, ativa: true };
  await comBotao('pmBtn', async () => {
    const ref = S.promoEdit ? FB.doc(db, 'promocoes', S.promoEdit) : FB.doc(FB.collection(db, 'promocoes'));
    await FB.setDoc(ref, S.promoEdit ? dados : { ...dados, criadoEm: FB.serverTimestamp() }, { merge: true });
    const novo = { id: ref.id, ...dados };
    S.promosPro = [novo, ...S.promosPro.filter(x => x.id !== ref.id)].sort((a, b) => (b.validaAte || '').localeCompare(a.validaAte || ''));
    limparPromo(); renderPromosPro();
    toast('Destaque publicado ✓ Os clientes já podem ver no Início.', 3400);
  });
}
async function removerPromo(id){
  if(!confirm('Apagar este destaque?')) return;
  await FB.deleteDoc(FB.doc(db, 'promocoes', id));
  S.promosPro = S.promosPro.filter(x => x.id !== id);
  if(S.promoEdit === id) limparPromo();
  renderPromosPro(); toast('Destaque apagado');
}

const colecaoPerfil = () => S.tipo === 'pro' ? 'profissionais' : 'clientes';
function escolherImagem(tipo){ const i = $(tipo === 'banner' ? 'fileBanner' : 'fileFoto'); if(i) i.click(); }

async function trocarImagem(tipo, input){
  const f = input.files && input.files[0];
  input.value = '';
  if(!f || !S.user) return;
  if(!/^image\//.test(f.type)) return toast('Escolha um arquivo de imagem (JPG ou PNG).');
  await comBotao(null, async () => {
    const ref = FB.doc(db, colecaoPerfil(), S.user.uid);
    if(tipo === 'foto'){
      const url = await ajustarImagem(f, 256, 256, FOTO_MAX, 'Ajustar foto'); if(!url) return;
      await FB.updateDoc(ref, { fotoUrl: url });
      S.perfil = { ...S.perfil, fotoUrl: url };
      if(S.tipo === 'pro'){ const i = S.pros.findIndex(p => p.id === S.user.uid); if(i >= 0) S.pros[i] = { ...S.pros[i], fotoUrl: url }; }
    }else{
      const url = await ajustarImagem(f, 960, 320, BANNER_MAX, 'Ajustar banner'); if(!url) return;
      await FB.setDoc(FB.doc(ref, 'midia', 'banner'), { dataUrl: url });
      S.bannerProprio = url;
      if(S.tipo === 'pro') S.banners[S.user.uid] = url;
    }
    S.tipo === 'pro' ? fillPro() : fillMe();
    toast(tipo === 'foto' ? 'Foto atualizada ✓' : 'Banner atualizado ✓');
  });
}

async function carregarBannerProprio(){
  try{
    const sn = await FB.getDoc(FB.doc(db, colecaoPerfil(), S.user.uid, 'midia', 'banner'));
    S.bannerProprio = sn.exists() ? (sn.data().dataUrl || '') : '';
    if(S.tipo === 'pro') S.banners[S.user.uid] = S.bannerProprio;
    if(S.tela === 's-me') setCover($('meCover'), S.bannerProprio);
    if(S.tela === 's-pro') setCover($('prCover'), S.bannerProprio);
  }catch(e){ console.warn('banner:', e); }
}

// Contas antigas (sem latitude/longitude): descobre pelo CEP já cadastrado, em segundo plano.
async function completarCoordenadas(){
  try{
    const uid = S.user.uid;
    if(S.tipo === 'cliente'){
      if(numOk(S.perfil.lat) || !cepValido(S.perfil.cepResi)) return;
      const pos = await geocodificarCep(S.perfil.cepResi); if(!pos || S.user.uid !== uid) return;
      await FB.updateDoc(FB.doc(db, 'clientes', uid), { lat: pos.lat, lng: pos.lng });
      S.perfil = { ...S.perfil, lat: pos.lat, lng: pos.lng };
      if(LIVE[S.tela]) LIVE[S.tela]();
    }else if(S.tipo === 'pro'){
      if(numOk(S.perfil.lat) || !cepValido((S.privado || {}).cepResi)) return;
      const pos = await geocodificarCep(S.privado.cepResi); if(!pos || S.user.uid !== uid) return;
      const g = { lat: aprox(pos.lat), lng: aprox(pos.lng) };
      await FB.updateDoc(FB.doc(db, 'profissionais', uid), g);
      S.perfil = { ...S.perfil, ...g };
    }
  }catch(e){ console.warn('coordenadas:', e); }
}

/* ---------------------------------------------------------------------
   NOTIFICAÇÃO NO CELULAR (push)
   O app guarda o "endereço" do celular (token FCM) em dispositivos/. Quem envia o aviso é a
   Cloud Function em functions/ (veja o LEIA-ME), disparada quando nasce um documento em notificacoes.
   --------------------------------------------------------------------- */
const hashTxt = t => { let h = 2166136261; for(let i = 0; i < t.length; i++){ h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const pushPlugin = () => {
  const C = window.Capacitor;
  if(!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
  return (C.Plugins && C.Plugins.PushNotifications) || (C.registerPlugin ? C.registerPlugin('PushNotifications') : null);
};
const tokenId = (uid, token) => `${uid}_${hashTxt(token)}`;
async function salvarToken(token){
  if(!S.user || !token) return;
  S.pushToken = token;
  try{
    await FB.setDoc(FB.doc(db, 'dispositivos', tokenId(S.user.uid, token)),
      { uid: S.user.uid, token, plataforma: window.Capacitor.getPlatform(), atualizadoEm: FB.serverTimestamp() });
  }catch(e){ console.warn('token push:', e); }
}
async function removerToken(){
  if(!S.user || !S.pushToken || !FB) return;
  try{ await FB.deleteDoc(FB.doc(db, 'dispositivos', tokenId(S.user.uid, S.pushToken))); }catch(e){ console.warn(e); }
  S.pushToken = null;
}
/* O aviso no celular só funciona quando o projeto Android tem o google-services.json (Firebase Cloud Messaging).
   Sem ele, chamar PushNotifications.register() derruba o app (erro nativo que o JavaScript não consegue capturar).
   Por isso: (1) fica desligado até você ligar `pushAtivo` em www/push-config.js, e (2) só liga quando a pessoa pede, no interruptor do perfil. */
let PUSH_OK = false;
async function lerPushConfig(){
  try{ PUSH_OK = (await import('./push-config.js')).pushAtivo === true; }catch(e){ PUSH_OK = false; }
}
const chavePush = () => 'bt_push_' + (S.user ? S.user.uid : '');
const pushLigado = () => { try{ return localStorage.getItem(chavePush()) === '1'; }catch(e){ return false; } };
const lembrarPush = on => { try{ on ? localStorage.setItem(chavePush(), '1') : localStorage.removeItem(chavePush()); }catch(e){} };

async function iniciarPush(){
  const PN = pushPlugin(); if(!PN || !PUSH_OK) return false;     // navegador, ou push não configurado: nada a fazer
  try{
    if(!S.pushOuvindo){
      S.pushOuvindo = true;
      PN.addListener('registration', t => salvarToken(t && t.value));
      PN.addListener('registrationError', e => console.warn('push:', e));
      PN.addListener('pushNotificationReceived', n => toast(((n && n.title) ? n.title + ': ' : '') + ((n && n.body) || ''), 4200));
      PN.addListener('pushNotificationActionPerformed', () => { if(S.user) abrirNotif(); });
    }
    let perm = await PN.checkPermissions();
    if(perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await PN.requestPermissions();
    if(perm.receive !== 'granted') return false;
    await PN.register();
    return true;
  }catch(e){ console.warn('push:', e); return false; }
}
// ao entrar: só reativa se a pessoa já tinha ligado antes neste aparelho
function retomarPush(){ if(PUSH_OK && pushLigado()) iniciarPush(); }

function renderPushSwitch(){
  const nativo = !!pushPlugin();
  document.querySelectorAll('.push-sw').forEach(el => el.classList.toggle('on', nativo && PUSH_OK && pushLigado()));
  const txt = !nativo ? 'Funciona só no aplicativo instalado no celular.'
    : !PUSH_OK ? 'Ainda não foi ativado neste app.'
    : S.tipo === 'pro' ? 'Aviso no celular quando um cliente marcar ou cancelar um horário com você.'
    : 'Aviso no celular quando o profissional confirmar ou cancelar o seu horário.';
  document.querySelectorAll('.push-txt').forEach(el => el.textContent = txt);
}
async function alternarPush(el){
  const nativo = !!pushPlugin();
  if(!nativo) return toast('Os avisos só funcionam no aplicativo instalado no celular.', 3600);
  if(!PUSH_OK) return toast('Os avisos no celular ainda não foram ativados neste app.', 4200);
  if(pushLigado()){
    await removerToken(); lembrarPush(false); renderPushSwitch(); return toast('Avisos no celular desligados.');
  }
  const ok = await iniciarPush();
  if(!ok){ renderPushSwitch(); return toast('Não foi possível ligar. Permita as notificações do BarbTech nas configurações do celular.', 4600); }
  lembrarPush(true); renderPushSwitch(); toast('Avisos no celular ligados ✓');
}

/* ---------------------------------------------------------------------
   ASSISTENTE VIRTUAL (chatbot.js)
   Aqui ficam só as "tomadas" que ligam o chatbot aos dados e às funções do app.
   --------------------------------------------------------------------- */
// Texto seguro para o backend do chatbot: só letras, números e " +-()." (até 60 caracteres).
const rotulo = s => String(s ?? '').replace(/[^\p{L}0-9 +\-().]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const limita = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(+n) ? +n : min));
const limiteAgenda = () => { const h = new Date(); return new Date(h.getFullYear(), h.getMonth() + JANELA_MESES + 1, 0); };

// O que o backend recebe junto com as mensagens: profissionais, serviços, horários e os horários marcados do cliente.
function contextoIA(){
  const professionals = prosRegiao().slice(0, 20).map(p => {
    const name = rotulo(p.nome); if(!name) return null;
    const barbershop = rotulo(nomeBarbearia(p));
    const ag = S.agendas[p.id] || {};
    const lista = hs => ORDEM_SEMANA.map(i => ({ day: DIAS[i], h: hs[DIAS[i]] }))
      .filter(x => x.h && x.h.aberto && /^\d{2}:\d{2}$/.test(x.h.inicio) && /^\d{2}:\d{2}$/.test(x.h.fim))
      .map(x => ({ day: x.day, start: x.h.inicio, end: x.h.fim }));
    const hours = lista(ag), homeHours = p.atendeDomicilio ? lista((S.agendasDom || {})[p.id] || {}) : [];
    const services = servicosDe(p.id).slice(0, 10)
      .map(s => ({ name: rotulo(s.nome), minutes: Math.round(limita(s.duracaoMin, 1, 1000)), price: Math.round(limita(s.precoBase, 0, 100000) * 100) / 100 }))
      .filter(s => s.name);
    return { name, ...(barbershop ? { barbershop } : {}), homeService: !!p.atendeDomicilio, ...(p.atendeDomicilio ? { homeFee: Math.round(limita(taxaDe(p), 0, 10000) * 100) / 100 } : {}), hours, homeHours, services };
  }).filter(Boolean);
  const appointments = S.agds.filter(proximo).slice(0, 20).map(a => {
    const sv = servicoPorId(a.servicoId), pro = S.pros.find(p => p.id === a.profissionalId);
    return { id: a.id, service: rotulo(sv && sv.nome) || 'Serviço', barber: rotulo(pro && pro.nome) || 'Profissional', date: a.data, time: a.horario, status: a.status };
  }).filter(a => /^[A-Za-z0-9]{4,28}$/.test(a.id) && /^\d{4}-\d{2}-\d{2}$/.test(a.date) && /^\d{2}:\d{2}$/.test(a.time));
  return { appointments, shop: { homeFee: TAXA_DOMICILIO, bookingUntil: ymd(limiteAgenda()), professionals } };
}

function criarAssistente(){
  bot = criarChatbot({
    SLOT_MIN, taxaDomicilio: TAXA_DOMICILIO, taxaDe, dataCurta, dinheiro,
    apiUrl: () => CHAT_URL,
    nomeCliente: () => (S.perfil && S.perfil.nome) ? primeiroNome(S.perfil.nome) : '',
    perfilCompleto: () => !!(S.perfil && S.perfil.perfilCompleto),
    profissionais: () => prosRegiao(),
    servicosDe,
    proximos: () => S.agds.filter(proximo).map(a => {
      const sv = servicoPorId(a.servicoId), pro = S.pros.find(p => p.id === a.profissionalId), st = STATUS[a.status] || { t: a.status };
      return { id: a.id, servico: sv ? sv.nome : 'Serviço removido', profissional: pro ? pro.nome : 'Profissional',
               quando: `${dataCurta(a.data)} às ${a.horario}`, status: st.t, domicilio: a.localAtendimento === 'DOMICILIO', pode: ativo(a) && futuro(a) };
    }),
    hoje: () => ymd(new Date()),
    limite: () => ymd(limiteAgenda()),
    carregarAgenda: async (pid, dom) => {
      const ag = await FB.getDoc(FB.doc(db, 'agendas', pid));
      return dom ? { ...HORARIOS_DOM_PADRAO, ...((ag.exists() && ag.data().horariosDomicilio) || {}) }
                 : { ...HORARIOS_PADRAO, ...((ag.exists() && ag.data().horarios) || {}) };
    },
    carregarOcupados: (pid, dia) => ocupadosDoDia(pid, dia),
    horasLivres,
    reservar,
    cancelar: id => mudarStatus(id, 'CANCELADO', 'cliente'),
    remarcar: id => { bot.fechar(); return ACTS.remarcar(id); },
    irPara: tela => { bot.fechar(); show(tela); },
    contextoIA,
    erroTexto: msgErro
  });
}


/* ---------------------------------------------------------------------
   Segurança: inatividade, consentimento (LGPD), recuperação de conta (código único e OTP), exportar e excluir dados
   --------------------------------------------------------------------- */
const POLITICA_VERSAO = '2026-10';

function iniciarTimeout(){
  SG.iniciarInatividade({
    minutos: SG.cfg.inatividadeMin,
    onAviso: () => toast('Sua sessão vai expirar em 1 minuto por inatividade.', 5000),
    onExpira: async () => { await sair(); toast('Sessão encerrada por inatividade. Entre novamente.', 4500); }
  });
}
const tokenAtual = () => S.user.getIdToken();
const auditar = async evento => { try{ SG.seg('/api/auditoria', { evento }, await tokenAtual()); }catch(e){} };

async function lerConsent(uid){
  try{ const sn = await FB.getDoc(FB.doc(db, 'consentimentos', uid)); return sn.exists() ? sn.data() : null; }
  catch(e){ console.warn('consentimento:', e); return null; }
}
// novo = true: a pessoa acabou de aceitar a política (registra data e versão); false: só mudou um consentimento
async function gravarConsent(uid, novo, extra = {}){
  const at = S.consent || {};
  const d = {
    versao: novo ? POLITICA_VERSAO : (at.versao || POLITICA_VERSAO),
    aceitoEm: novo ? new Date().toISOString() : (at.aceitoEm || new Date().toISOString()),
    localizacao: at.localizacao !== false, condicao: at.condicao !== false,
    ...extra, atualizadoEm: new Date().toISOString()
  };
  await FB.setDoc(FB.doc(db, 'consentimentos', uid), d);
  S.consent = d;
}

function abrirPrivacidade(aceite){
  if(!aceite) S.privVoltar = S.tela;
  $('privVersao').textContent = POLITICA_VERSAO;
  $('privContato').textContent = SG.cfg.contatoPrivacidade || 'o responsável pelo projeto (defina em www/seguranca-config.js)';
  $('privAceite').hidden = !aceite; $('privVoltar').hidden = !!aceite;
  show('s-priv');
}
function voltarPriv(){ show(S.privVoltar && S.privVoltar !== 's-priv' ? S.privVoltar : 's-login'); }
async function aceitarPolitica(){
  await comBotao('privAceitoBtn', async () => { await gravarConsent(S.user.uid, true); await iniciarSessao(S.user); });
}
async function alternarConsent(k, el){
  if(!S.user) return;
  const novo = !el.classList.contains('on');
  await comBotao(null, async () => {
    await gravarConsent(S.user.uid, false, { [k]: novo });
    el.classList.toggle('on', novo);
    if(k === 'localizacao'){
      if(novo) await completarCoordenadas();
      else{
        const ref = FB.doc(db, colecaoPerfil(), S.user.uid);
        await FB.updateDoc(ref, { lat: null, lng: null });
        S.perfil = { ...S.perfil, lat: null, lng: null };
        const i = S.pros.findIndex(p => p.id === S.user.uid); if(i >= 0) S.pros[i] = { ...S.pros[i], lat: null, lng: null };
      }
    }
    auditar('consentimento_alterado');
    toast(novo ? 'Consentimento ativado.' : 'Consentimento retirado.');
  });
}

/* ----- Segurança e privacidade (tela) ----- */
function abrirSeg(){ S.segVoltar = S.tela; show('s-seg'); }
function voltarSeg(){ show(S.segVoltar && S.segVoltar !== 's-seg' ? S.segVoltar : (S.tipo === 'pro' ? 's-pagenda' : 's-home')); }
async function renderSeg(){
  const c = S.consent || {};
  $('cs-loc').classList.toggle('on', c.localizacao !== false);
  $('cs-cond').classList.toggle('on', c.condicao !== false);
  $('csCondBox').hidden = S.tipo !== 'cliente';
  $('csLocTxt').textContent = S.tipo === 'pro' ? 'Mostra aos clientes a distância até você. Usamos só uma posição aproximada (cerca de 1 km), nunca o seu endereço.' : 'Mostra a distância e filtra profissionais da sua região.';
  $('csInfo').textContent = c.aceitoEm ? `Política de privacidade v${c.versao} aceita em ${new Date(c.aceitoEm).toLocaleDateString('pt-BR')}.` : '';
  renderMfa();
  $('segCodBox').hidden = true; $('segCodSenha').value = '';
  const btn = $('segCodBtn'), txt = $('segCodTxt'), campo = $('segCodSenhaBox');
  if(!temSenha()){ txt.textContent = 'Sua conta entra com o Google, então não tem senha para recuperar: se perder o acesso, recupere pela própria conta Google.'; btn.hidden = true; campo.hidden = true; return; }
  txt.textContent = 'Verificando…'; btn.hidden = true; campo.hidden = true;
  let cofre = null;
  try{ const sn = await FB.getDoc(FB.doc(db, 'recuperacao', String(S.user.email).toLowerCase())); cofre = sn.exists() ? sn.data() : null; }
  catch(e){ txt.textContent = 'Não foi possível consultar agora. Tente de novo mais tarde.'; return; }
  S.temCodigo = !!cofre;
  txt.textContent = S.temCodigo
    ? `Você tem um código de recuperação, criado em ${new Date(cofre.criadoEm).toLocaleDateString('pt-BR')}. Com ele você recupera a conta se esquecer a senha. Ele aparece só uma vez: se perdeu, gere um novo (o antigo deixa de valer). Para gerar, confirme a sua senha.`
    : 'Você ainda não tem um código de recuperação. Gere um e guarde em lugar seguro: se esquecer a senha, é com ele que você recupera a conta. Para gerar, confirme a sua senha.';
  btn.textContent = S.temCodigo ? 'Gerar novo código' : 'Gerar código'; btn.hidden = false; campo.hidden = false;
}
const temSenha = () => !!(S.user && S.user.providerData && S.user.providerData.some(p => p.providerId === 'password'));
async function codGerar(){
  const senha = $('segCodSenha').value;
  if(!senha) return toast('Digite a sua senha para gerar o código.', 3200);
  await comBotao('segCodBtn', async () => {
    try{ await FB.reauthenticateWithCredential(S.user, FB.EmailAuthProvider.credential(S.user.email, senha)); }
    catch(e){ console.error(e); return toast(credInvalida(e) ? 'Senha incorreta.' : msgErro(e), 3600); }
    const codigo = await gravarCofre(S.user, senha);
    await renderSeg();
    await mostrarCodigo(codigo, { titulo: 'Seu novo código', texto: 'O código anterior deixou de valer. Baixe o arquivo ou anote este em um lugar seguro: ele aparece apenas agora.', botao: 'Fechar' });
    toast('Código gerado ✓');
  });
}
// pop-up que mostra o código uma única vez; devolve uma promessa que se resolve quando a pessoa confirma que guardou
function mostrarCodigo(codigo, { titulo, texto, botao, email }){
  $('codTitulo').textContent = titulo; $('codTexto').textContent = texto; $('codValor').textContent = codigo;
  S.codigoEmail = email || (S.user && S.user.email) || '';
  $('codOk').checked = false; $('codBtn').disabled = true; $('codBtn').textContent = botao || 'Continuar';
  $('s-codigo').hidden = false;
  return new Promise(fim => { S.codigoFim = fim; });
}
function codigoFechar(){ const f = S.codigoFim; S.codigoFim = null; $('codValor').textContent = ''; $('s-codigo').hidden = true; if(f) f(); }
function baixarCodigoAtual(){ RC.baixarCodigo($('codValor').textContent, S.codigoEmail); }
async function copiarCodigo(txt){
  const v = typeof txt === 'string' ? txt : $('codValor').textContent;
  try{ await navigator.clipboard.writeText(v); toast('Código copiado.'); }
  catch(e){ toast('Não consegui copiar. Anote o código com cuidado.', 3600); }
}
// cria o cofre da conta: criptografa a senha com um código novo e guarda em recuperacao/{e-mail}; devolve o código
async function gravarCofre(user, senha){
  const email = String(user.email || '').toLowerCase(), codigo = RC.gerarCodigo();
  const cofre = await RC.fecharCofre({ email, uid: user.uid, senha, codigo });
  await FB.setDoc(FB.doc(db, 'recuperacao', email), cofre);
  return codigo;
}
// logo depois do cadastro: gera o código, mostra num pop-up (copiar ou baixar) e só então abre o app
async function exibirCodigoCadastro(user, senha){
  let codigo;
  try{ codigo = await gravarCofre(user, senha); }
  catch(e){ console.warn('cofre:', e); toast('Não foi possível gerar o código de recuperação agora. Gere em Perfil → Segurança e privacidade.', 5000); return; }
  await mostrarCodigo(codigo, {
    titulo: 'Guarde seu código de recuperação',
    texto: 'Este código é só seu: ninguém mais o conhece, nem a equipe do BarbTech. Se você esquecer a senha, é com ele que você recupera a conta. Baixe o arquivo ou anote em um lugar seguro, porque ele aparece apenas agora.',
    botao: 'Entrar no app', email: user.email
  });
}

/* ----- recuperação de senha por código (OTP) ----- */
const recErro = t => { $('recErr').textContent = t || ''; };
function abrirRecuperacao(){
  $('rec-email').value = $('email').value.trim();
  ['rec-cod','rec-senha','rec-senha2'].forEach(i => $(i).value = '');
  ['rec0-cod','rec0-senha','rec0-senha2'].forEach(i => $(i).value = ''); $('rec0-email').value = $('email').value.trim(); $('rec0Err').textContent = '';
  $('recP0').hidden = false; $('recP1').hidden = true; $('recP2').hidden = true; recErro('');
  if(pintarRec) pintarRec(); if(pintarRec0) pintarRec0();
  show('s-recup');
}
function recMostrarEmail(){
  $('recP0').hidden = true; $('recP1').hidden = false; $('rec-email').value = val('rec0-email'); recErro('');
  const srv = SG.temServico();      // o código de 6 dígitos por e-mail só existe se o serviço de segurança estiver no ar
  $('recBtn1').hidden = !srv; $('recSrvTxt').hidden = !srv; $('recLinkTxt').hidden = srv;
  $('recLinkBtn').className = srv ? 'linklike' : 'btn btn-gold';
}
function recMostrarCodigo(){ $('recP1').hidden = true; $('recP2').hidden = true; $('recP0').hidden = false; recErro(''); }
// recuperação pelo código único de recuperação (o do cadastro): tudo acontece no app + Firebase, sem servidor próprio
async function recCodigoRedefinir(){
  const email = val('rec0-email').toLowerCase(), codigo = $('rec0-cod').value, s1 = $('rec0-senha').value, s2 = $('rec0-senha2').value;
  const erro = t => { $('rec0Err').textContent = t || ''; };
  if(!FB) return semFirebase();
  if(!SG.emailValido(email)) return erro('Informe um e-mail válido.');
  if(!RC.codigoCompleto(codigo)) return erro('Digite o código de recuperação completo (20 letras e números).');
  if(!SG.avaliarSenha(s1).ok) return erro('A nova senha não atende a todos os requisitos de segurança.');
  if(s1 !== s2) return erro('As senhas não conferem.');
  const lk = SG.bloqueioLocal('rec:' + email);
  if(lk.bloqueado) return erro(`Muitas tentativas. Tente novamente em ${SG.fmtEspera(lk.restanteSeg)}.`);
  erro('');
  const GENERICO = 'E-mail ou código incorretos.';
  await comBotao('rec0Btn', async () => {
    S.autenticando = true;
    try{
      let cofre = null;
      try{ const sn = await FB.getDoc(FB.doc(db, 'recuperacao', email)); cofre = sn.exists() ? sn.data() : null; }
      catch(e){ if(e && e.code === 'unavailable') return erro('Não foi possível concluir agora. Verifique a internet.'); throw e; }
      const antiga = cofre ? await RC.abrirCofre({ email, cofre, codigo }) : null;
      if(!antiga){ const f = SG.falhaLocal('rec:' + email); return erro(f.bloqueado ? `Muitas tentativas. Bloqueado por ${SG.fmtEspera(f.restanteSeg)}.` : GENERICO); }
      let user;
      try{ user = (await FB.signInWithEmailAndPassword(auth, email, antiga)).user; }
      catch(e){
        if(e && e.code === 'auth/multi-factor-auth-required') return erro('Esta conta usa verificação em duas etapas. Para redefinir a senha, use o link por e-mail (Recuperar por e-mail).');
        if(credInvalida(e)) return erro('Este código não vale mais para a conta (a senha foi trocada por outro meio). Use o link por e-mail, abaixo.');
        throw e;
      }
      await FB.updatePassword(user, s1);
      const novo = await gravarCofre(user, s1);     // gera um código novo: o que foi usado deixa de valer
      await FB.signOut(auth);
      SG.sucessoLocal('rec:' + email);
      $('email').value = email; $('senha').value = '';
      await mostrarCodigo(novo, {
        titulo: 'Senha redefinida',
        texto: 'O código que você usou deixou de valer. Este é o seu novo código de recuperação: baixe o arquivo ou anote em um lugar seguro, porque ele aparece apenas agora.',
        botao: 'Ir para o login', email
      });
      show('s-login'); toast('Entre com a nova senha.', 3600);
    }catch(e){ console.error(e); erro(msgErro(e)); }
    finally{ S.autenticando = false; }
  });
}
async function recSolicitar(reenvio){
  const email = (reenvio === true ? S.recEmail : val('rec-email')).toLowerCase();
  if(!SG.emailValido(email)) return recErro('Informe um e-mail válido.');
  if(!SG.temServico()) return recErro('O envio de código por e-mail não está ativo agora. Use a opção "receber um link por e-mail".');
  recErro('');
  await comBotao(reenvio === true ? 'recBtn2' : 'recBtn1', async () => {
    const r = await SG.seg('/api/otp/solicitar', { email });
    if(r.rede || r.indisponivel) return recErro('Não foi possível enviar agora. Verifique a internet e tente de novo.');
    if(r.status === 429) return recErro('Muitas solicitações. Tente novamente mais tarde.');
    if(!r.ok) return recErro('Não foi possível enviar agora. Tente novamente.');
    S.recEmail = email;
    $('recMsg').textContent = 'Se o e-mail estiver cadastrado, enviamos um código de 6 dígitos válido por 10 minutos. Digite-o abaixo com a nova senha.';
    $('recP1').hidden = true; $('recP2').hidden = false;
  });
}
async function recRedefinir(){
  const codigo = val('rec-cod'), s1 = $('rec-senha').value, s2 = $('rec-senha2').value;
  if(!/^\d{6}$/.test(codigo)) return recErro('Digite o código de 6 dígitos.');
  if(!SG.avaliarSenha(s1).ok) return recErro('A nova senha não atende a todos os requisitos de segurança.');
  if(s1 !== s2) return recErro('As senhas não conferem.');
  recErro('');
  await comBotao('recBtn2', async () => {
    const r = await SG.seg('/api/otp/redefinir', { email: S.recEmail, codigo, novaSenha: s1 });
    if(r.status === 429) return recErro('Muitas tentativas. Tente novamente mais tarde.');
    if(!r.ok) return recErro(r.rede || r.indisponivel ? 'Não foi possível concluir agora. Verifique a internet.' : (r.dados && r.dados.erro) || 'Não foi possível redefinir a senha.');
    SG.sucessoLocal(S.recEmail);
    $('email').value = S.recEmail; $('senha').value = '';
    show('s-login'); toast('Senha redefinida ✓ Entre com a nova senha.', 4200);
  });
}
// alternativa sem o serviço de segurança: link padrão do Firebase (a resposta é sempre a mesma, exista o e-mail ou não)
async function recLink(){
  const email = val('rec-email').toLowerCase();
  if(!SG.emailValido(email)) return recErro('Informe um e-mail válido.');
  if(!FB) return semFirebase();
  try{ await FB.sendPasswordResetEmail(auth, email); }catch(e){ console.warn(e); }
  recErro(''); toast('Se esse e-mail estiver cadastrado, enviamos um link para redefinir a senha.', 4200);
}

/* ----- direitos do titular: baixar e excluir ----- */
async function exportarDados(){
  const uid = S.user.uid;
  const semImg = o => { const c = { ...o }; if(c.fotoUrl) c.fotoUrl = '[imagem]'; return c; };
  const out = { exportadoEm: new Date().toISOString(), tipo: S.tipo, conta: { email: S.user.email, uid }, perfil: semImg(S.perfil || {}), consentimentos: S.consent, agendamentos: S.agds };
  if(S.tipo === 'pro'){ try{ const sn = await FB.getDoc(FB.doc(db, 'profissionais', uid, 'privado', 'dados')); out.dadosPrivados = sn.exists() ? sn.data() : null; }catch(e){ console.warn(e); } }
  const json = JSON.stringify(out, null, 2);
  const ta = $('expOut'); ta.value = json; ta.hidden = false;
  try{
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = 'meus-dados-barbtech.json';
    document.body.appendChild(a); a.click(); a.remove();
  }catch(e){ console.warn(e); }
  auditar('dados_exportados');
  toast('Seus dados estão na caixa abaixo (e foram baixados, se o aparelho permitir).', 4200);
}
async function excluirConta(){
  if(!S.user) return;
  if(!confirm('Excluir sua conta e seus dados? Isso não pode ser desfeito.')) return;
  const porSenha = temSenha();
  const senha = porSenha ? prompt('Por segurança, digite a sua senha para confirmar:') : '';
  if(porSenha && !senha) return;
  await comBotao(null, async () => {
    const uid = S.user.uid;
    try{
      if(porSenha) await FB.reauthenticateWithCredential(S.user, FB.EmailAuthProvider.credential(S.user.email, senha));
      else if(nativo()){ const P = googleNativo(); const r = await P.signInWithGoogle({ skipNativeAuth: true }); await FB.reauthenticateWithCredential(S.user, FB.GoogleAuthProvider.credential(r.credential.idToken)); }
      else await FB.reauthenticateWithPopup(S.user, new FB.GoogleAuthProvider());
    }catch(e){ console.error(e); if(googleCancelou(e)) return; return toast(credInvalida(e) ? 'Senha incorreta.' : msgErro(e), 3600); }
    await SG.seg('/api/auditoria', { evento: 'conta_excluida' }, await tokenAtual());
    const col = colecaoPerfil(), apagar = async ref => { try{ await FB.deleteDoc(ref); }catch(e){ console.warn('exclusão:', e && e.code); } };
    try{ const ds = await FB.getDocs(FB.query(FB.collection(db, 'dispositivos'), FB.where('uid', '==', uid))); for(const d of ds.docs) await apagar(d.ref); }catch(e){ console.warn(e); }
    await apagar(FB.doc(db, col, uid, 'midia', 'banner'));
    if(S.tipo === 'pro'){ await apagar(FB.doc(db, 'profissionais', uid, 'privado', 'dados')); await apagar(FB.doc(db, 'agendas', uid)); }
    await apagar(FB.doc(db, 'consentimentos', uid));
    if(S.user.email) await apagar(FB.doc(db, 'recuperacao', String(S.user.email).toLowerCase()));
    await apagar(FB.doc(db, col, uid));
    S.autenticando = true;
    try{ await FB.deleteUser(S.user); }catch(e){ console.error(e); }
    finally{ S.autenticando = false; }
    logoutView(); toast('Conta excluída.', 4200);
  });
}

/* ---------------------------------------------------------------------
   telas: o que carregar ao entrar + cliques dos elementos dinâmicos
   --------------------------------------------------------------------- */
const ENTER = {
  's-login':   () => { loginErro(''); $('loginRole').textContent = S.roleChoice === 'pro' ? 'Acesso do profissional — gerencie sua agenda e seus clientes.' : 'Acesso do cliente — marque e acompanhe seus horários.'; },
  's-home':    () => { renderHome(); refreshPublico(); },
  's-barbers': () => { renderBarbers(); refreshPublico(); },
  's-barber':  () => renderBarber(),
  's-meus':    () => { renderMeus(); refreshPublico(); },
  's-notif':   () => renderNotif(),
  's-me':      () => fillMe(),
  's-cadcli':  () => {},
  's-pagenda': () => renderPAgenda(),
  's-bi':      () => renderBI(),
  's-pro':     () => fillPro(),
  's-seg':     () => renderSeg()
};
// telas que se atualizam sozinhas quando o Firestore avisa de mudanças (não inclui telas com formulário)
const LIVE = { 's-home': renderHome, 's-barbers': renderBarbers, 's-meus': renderMeus, 's-pagenda': renderPAgenda, 's-bi': renderBI };

const ACTS = {
  destaque:   id => { S.destaque = id; renderHome(); },
  verTodasRegioes: () => setRaio(0),
  abrirPro:   id => abrirPro(id),
  abrirPromo: id => abrirPromo(id),
  editPromo:  id => editarPromo(id),
  delPromo:   id => removerPromo(id),
  svc:        id => {
    if(S.remarcando) return toast('Para trocar o serviço, cancele este horário e agende de novo.', 3400);
    S.sel.servicoId = id; S.sel.hora = null; renderBarber(); carregarSlots();
  },
  dia:        id => { S.sel.dia = id; S.sel.hora = null; renderCal(); carregarSlots(); },
  slot:       id => { S.sel.hora = id; renderSlots(); renderResumo(); },
  remarcar:   id => { const a = S.agds.find(x => x.id === id); if(a) return abrirPro(a.profissionalId, a); },
  cancelarCli:id => { if(confirm('Cancelar este horário?')) return mudarStatus(id, 'CANCELADO', 'cliente'); },
  pConfirmar: id => mudarStatus(id, 'CONFIRMADO', 'pro'),
  pIniciar:   id => iniciarAtendimento(id),
  pConcluir:  id => mudarStatus(id, 'CONCLUIDO', 'pro'),
  modo:       id => escolherModo(id),
  biPeriodo:  id => { S.biPeriodo = id; renderBI(); },
  pCancelar:  id => { if(confirm('Cancelar este horário? O cliente será avisado.')) return mudarStatus(id, 'CANCELADO', 'pro'); },
  editSvc:    id => editarServico(id),
  delSvc:     id => removerServico(id),
  horaSw:     (id, el) => { el.classList.toggle('on'); el.parentElement.classList.toggle('fechado', !el.classList.contains('on')); }
};
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if(!el || !ACTS[el.dataset.act] || el.dataset.busy) return;
  el.dataset.busy = '1';
  try{ await ACTS[el.dataset.act](el.dataset.id, el); }
  catch(err){ console.error(err); toast(msgErro(err), 3600); }
  finally{ delete el.dataset.busy; }
});

// funções chamadas pelos atributos onclick/oninput do HTML
Object.assign(window, {
  show, go, sw, tab, toast, entrar, criarConta, esqueciSenha, cadastrarPro, voltarCadPro, sair,
  abrirNotif, voltarNotif, limparNotif, irBusca, toggleFiltro, renderBarbers,
  voltarBarber, mesCal, domProToggle, confirmar, salvarPerfil, salvarServico, limparServico, salvarPro, barbSelecionada,
  togglePerto, setRaio, abrirRecuperacao, recSolicitar, recRedefinir, recLink, recCodigoRedefinir, recMostrarEmail, recMostrarCodigo, codGerar, copiarCodigo, codigoFechar, baixarCodigoAtual, entrarGoogle, mfaConfirmar, mfaCancelar, mfaIniciar, mfaConfirmarAtivacao, mfaDesativar, abrirSeg, voltarSeg, abrirPrivacidade, voltarPriv, aceitarPolitica, alternarConsent, exportarDados, excluirConta, escolherImagem, trocarImagem, cadastrarCli, salvarPromo, limparPromo, promoTipoToggle, alternarPush
});

/* dots do carrossel da home */
(function(){
  const rail = $('rail');
  rail.addEventListener('scroll', () => {
    const n = rail.children.length || 1, i = Math.round(rail.scrollLeft / (rail.scrollWidth / n));
    document.querySelectorAll('#railDots .dot').forEach((d, k) => d.classList.toggle('on', k === i));
  }, { passive: true });
})();

/* ---------------------------------------------------------------------
   início
   --------------------------------------------------------------------- */
['cp-uf','me-uf','pr-uf','cc-uf'].forEach(popularUF);
['cp','me','pr','bb','cc'].forEach(ligarCep);

criarAssistente();
aplicarLimites();
pintarCp = SG.ligarValidadorSenha('cp-senha', 'cp-rules');
SG.ligarValidadorSenha('cc-senha', 'cc-rules', 'cc-senha2');
pintarRec = SG.ligarValidadorSenha('rec-senha', 'rec-rules', 'rec-senha2');
pintarRec0 = SG.ligarValidadorSenha('rec0-senha', 'rec0-rules', 'rec0-senha2');
// erros não tratados: nada técnico vai para a tela, só para o console
window.addEventListener('error', e => console.error(e.error || e.message));
window.addEventListener('unhandledrejection', e => { console.error(e.reason); e.preventDefault(); toast('Não foi possível concluir agora. Tente novamente.'); });

(async function init(){
  // URL do backend do chatbot (opcional): sem ela o assistente funciona só pelos botões do menu
  try{ CHAT_URL = String((await import('./chatbot-config.js')).chatbotApiUrl || '').trim(); }catch(e){ console.warn('chatbot-config.js não encontrado'); }
  await lerPushConfig();
  if(!await initFirebase()){ hideBoot(); return; }
  FB.onAuthStateChanged(auth, async user => {
    if(S.autenticando) return;                         // login/cadastro em andamento: ele mesmo abre a tela
    if(!user){ if(S.sessaoUid) logoutView(); hideBoot(); return; }
    if(S.sessaoUid === user.uid){ hideBoot(); return; }
    if(SG.inatividadeExpirada()){ try{ await FB.signOut(auth); }catch(e){} try{ localStorage.removeItem('bt_ult'); }catch(e){} hideBoot(); toast('Sessão encerrada por inatividade. Entre novamente.', 4500); return; }
    try{ await iniciarSessao(user); }
    catch(e){ console.error(e); logoutView(); toast(msgErro(e), 4200); }
    hideBoot();
  });
})();
