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

   Assistente virtual (chatbot): chatbot.js, com backend em backend-chatbot/.
   ===================================================================== */

import { criarChatbot } from './chatbot.js';

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

const CLIENTE_VAZIO = {
  nome:'', telefone:'', estado:'', cpf:'', cnpj:'',
  logradouroResidencia:'', bairroResidencia:'', cepResi:'', complementoResidencia:'',
  condicao:'', perfilCompleto:false
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
const val = id => $(id).value.trim();

// blocos de 30 min ocupados por um agendamento → ids dos documentos em horariosOcupados
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
let bot = null, CHAT_URL = '';      // assistente virtual e a URL do backend dele (chatbot-config.js)

const S = {
  tela: 's-splash', roleChoice: 'cliente',
  user: null, tipo: null, perfil: null, privado: null,
  sessaoUid: null, autenticando: false, completandoPro: false,
  pros: [], servicos: [], barbearias: {}, agendas: {}, pubTs: 0,
  agds: [], notifs: [], unsubs: [],
  destaque: null, soDomicilio: false,
  // agendamento em andamento
  pro: null, agendaPro: null, sel: {servicoId:null, dia:null, hora:null, dom:false},
  calRef: new Date(), ocupados: new Set(), slotReq: 0, remarcando: null, origem: 's-barbers',
  // painel do profissional
  horariosPro: {...HORARIOS_PADRAO}, svEditId: null, voltarPara: null
};

/* ---------------------------------------------------------------------
   interface básica
   --------------------------------------------------------------------- */
const SEM_BARRA = ['s-splash','s-login','s-cadpro'];
const SEM_BOT = ['s-splash','s-login','s-cadpro','s-barber'];   // s-barber tem a barra de confirmação no rodapé

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
}
const hideBoot = () => { $('boot').hidden = true; };
const avisoCfg = msg => { const w = $('cfgWarn'); w.textContent = '⚠ ' + msg; w.hidden = false; };
const loginErro = msg => { $('loginErr').textContent = msg || ''; };

function msgErro(e){
  const c = (e && e.code) || '';
  const m = {
    'auth/invalid-email': 'E-mail inválido.',
    'auth/missing-password': 'Informe a senha.',
    'auth/user-not-found': 'E-mail ou senha incorretos.',
    'auth/wrong-password': 'E-mail ou senha incorretos.',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/invalid-login-credentials': 'E-mail ou senha incorretos.',
    'auth/email-already-in-use': 'Esse e-mail já está cadastrado. Use "Entrar no atelier".',
    'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
    'auth/network-request-failed': 'Sem conexão com a internet.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente de novo.',
    'auth/operation-not-allowed': 'Login por e-mail/senha não está ativado no Firebase (Authentication → Método de login).',
    'permission-denied': 'Sem permissão para essa ação. Confira se as regras do Firestore foram publicadas.',
    'unavailable': 'Sem conexão com o servidor. Tente de novo.',
    'failed-precondition': 'O Firestore pediu um índice ou ainda não foi criado. Veja o console do navegador.'
  };
  return m[c] || ('Algo deu errado' + (c ? ` (${c})` : '') + '.');
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

async function entrar(){
  if(!FB) return semFirebase();
  const email = val('email'), senha = $('senha').value;
  if(!email || !senha) return loginErro('Informe e-mail e senha.');
  loginErro('');
  await comBotao('btnEntrar', async () => {
    S.autenticando = true;
    try{
      await FB.setPersistence(auth, $('manter').checked ? FB.browserLocalPersistence : FB.browserSessionPersistence);
      const cred = await FB.signInWithEmailAndPassword(auth, email, senha);
      await iniciarSessao(cred.user);
    }catch(e){ erroNoLogin(e); }
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
  const email = val('email'), senha = $('senha').value;
  if(!email) return loginErro('Informe um e-mail.');
  if(senha.length < 6) return loginErro('A senha precisa ter pelo menos 6 caracteres.');
  loginErro('');
  await comBotao('btnCriar', async () => {
    S.autenticando = true;
    try{
      await FB.setPersistence(auth, $('manter').checked ? FB.browserLocalPersistence : FB.browserSessionPersistence);
      const cred = await FB.createUserWithEmailAndPassword(auth, email, senha);
      try{
        await FB.setDoc(FB.doc(db, 'clientes', cred.user.uid), CLIENTE_VAZIO);
      }catch(e){
        await FB.deleteUser(cred.user).catch(() => {});   // desfaz a conta se o perfil não pôde ser criado
        throw e;
      }
      await iniciarSessao(cred.user);
    }catch(e){ erroNoLogin(e); }
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
  ['cp-nome','cp-tel','cp-cpf','cp-cnpj','cp-rua','cp-cep','cp-bairro','cp-comp','cp-senha'].forEach(i => $(i).value = '');
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
    bairroResidencia: val('cp-bairro'), complementoResidencia: val('cp-comp')
  };
  if(!S.completandoPro){
    if(!email) return toast('Informe o e-mail.');
    if(senha.length < 6) return toast('A senha precisa ter pelo menos 6 caracteres.');
  }
  if(!d.nome) return toast('Informe seu nome.');
  if(!d.telefone) return toast('Informe seu telefone.');
  if(!d.estado) return toast('Escolha o estado.');
  if(!d.cpf && !d.cnpj) return toast('Informe o CPF ou o CNPJ.');
  if(!d.logradouroResidencia || !d.cepResi || !d.bairroResidencia) return toast('Preencha o endereço (rua, CEP e bairro).');

  await comBotao('cpBtn', async () => {
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
      const priv = { cpf:d.cpf, cnpj:d.cnpj, logradouroResidencia:d.logradouroResidencia, bairroResidencia:d.bairroResidencia, cepResi:d.cepResi, complementoResidencia:d.complementoResidencia };
      const batch = FB.writeBatch(db);
      batch.set(FB.doc(db, 'profissionais', uid), {
        nome: d.nome, telefone: d.telefone, estado: d.estado,
        atendeDomicilio: $('cp-dom').classList.contains('on'), barbeariaId: null, sobre: ''
      });
      batch.set(FB.doc(db, 'profissionais', uid, 'privado', 'dados'), priv);
      batch.set(FB.doc(db, 'agendas', uid), { profissionalId: uid, horarios: HORARIOS_PADRAO });
      try{ await batch.commit(); }
      catch(e){ if(criou) await FB.deleteUser(user).catch(() => {}); throw e; }
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

    if(S.tipo === 'pro'){
      await carregarPro();
      iniciarListeners();
      if(!S.servicos.length){ show('s-pro'); toast('Cadastre seus serviços para receber agendamentos.', 3600); }
      else show('s-pagenda');
    }else{
      await carregarPublico();
      iniciarListeners();
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
    pros:[], servicos:[], barbearias:{}, agendas:{}, pubTs:0, agds:[], notifs:[], pro:null, remarcando:null, destaque:null });
  if(bot) bot.resetar();
  $('senha').value = ''; loginErro('');
  show('s-splash');
}
async function sair(){
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
async function carregarPublico(){
  const [ps, ss, bs, ags] = await Promise.all([
    FB.getDocs(FB.collection(db, 'profissionais')),
    FB.getDocs(FB.collection(db, 'servicos')),
    FB.getDocs(FB.collection(db, 'barbearias')),
    FB.getDocs(FB.collection(db, 'agendas'))
  ]);
  S.pros = docs(ps).sort((a,b) => (a.nome||'').localeCompare(b.nome||''));
  S.servicos = docs(ss);
  S.barbearias = Object.fromEntries(docs(bs).map(b => [b.id, b]));
  S.agendas = Object.fromEntries(docs(ags).map(a => [a.id, a.horarios || {}]));   // horários de trabalho (usados pelo assistente)
  S.pubTs = Date.now();
}
async function refreshPublico(){
  if(S.tipo !== 'cliente' || Date.now() - S.pubTs < 20000) return;
  try{ await carregarPublico(); LIVE[S.tela] && LIVE[S.tela](); }catch(e){ console.warn(e); }
}

// Profissional: lê agenda, serviços próprios, dados privados e barbearias.
async function carregarPro(){
  const uid = S.user.uid;
  const [ag, sv, pv, bs] = await Promise.all([
    FB.getDoc(FB.doc(db, 'agendas', uid)),
    FB.getDocs(FB.query(FB.collection(db, 'servicos'), FB.where('profissionalId', '==', uid))),
    FB.getDoc(FB.doc(db, 'profissionais', uid, 'privado', 'dados')),
    FB.getDocs(FB.collection(db, 'barbearias'))
  ]);
  S.horariosPro = { ...HORARIOS_PADRAO, ...((ag.exists() && ag.data().horarios) || {}) };
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
  const acts = (comAcoes && ativo(a) && futuro(a))
    ? `<div class="acts"><button class="btn btn-line btn-sm" data-act="remarcar" data-id="${esc(a.id)}">Remarcar</button><button class="btn btn-danger btn-sm" data-act="cancelarCli" data-id="${esc(a.id)}">Cancelar</button></div>` : '';
  return `<div class="acard"><div class="top"><span class="ic">${ICON_CAL}</span>
    <span class="tx"><b>${esc(sv ? sv.nome : 'Serviço removido')}</b>
    <span>${esc(dataCurta(a.data))} · ${esc(a.horario)} · ${esc(pro ? pro.nome : 'Profissional')}</span>
    ${a.localAtendimento === 'DOMICILIO' ? '<span>Atendimento em casa</span>' : ''}</span>
    <span class="st ${st.c}">${st.t}</span></div>${acts}</div>`;
}

function renderHome(){
  renderBell();
  const av = $('homeAvatars'), ft = $('homeFeature');
  if(!S.pros.length){
    av.innerHTML = '';
    ft.innerHTML = '<div class="empty">Nenhum profissional cadastrado ainda.<br>Volte em breve!</div>';
  }else{
    if(!S.pros.some(p => p.id === S.destaque)) S.destaque = S.pros[0].id;
    av.innerHTML = S.pros.map(p =>
      `<div class="av ${p.id === S.destaque ? 'on' : ''}" data-act="destaque" data-id="${esc(p.id)}"><div class="pic ph ph-face initials">${esc(inic(p.nome))}</div><span>${esc(primeiroNome(p.nome))}</span></div>`).join('');
    const p = S.pros.find(x => x.id === S.destaque);
    ft.innerHTML = `<article class="feature"><div class="pic ph ph-face initials">${esc(inic(p.nome))}</div>
      <div class="body"><h3>${esc(p.nome)}</h3><div class="role-txt">${esc(subPro(p))}</div>
      <p>${esc(p.sobre || 'Este profissional ainda não escreveu a apresentação.')}</p>
      <button class="btn btn-gold" style="margin-top:16px" data-act="abrirPro" data-id="${esc(p.id)}">Ver agenda</button></div></article>`;
  }
  const prox = S.agds.find(proximo);
  $('homeNext').innerHTML = prox ? cardAgdCliente(prox, false)
    : '<div class="empty">Você ainda não tem horários marcados.</div>';
}

function irBusca(){ show('s-barbers'); setTimeout(() => $('busca').focus(), 60); }
function toggleFiltro(){
  S.soDomicilio = !S.soDomicilio;
  $('btnFiltro').classList.toggle('has-dot', S.soDomicilio);
  $('filtroInfo').hidden = !S.soDomicilio;
  renderBarbers();
}
function renderBarbers(){
  const q = norm($('busca').value);
  let l = S.pros.filter(p => !S.soDomicilio || p.atendeDomicilio);
  if(q) l = l.filter(p => norm(p.nome).includes(q) || norm(nomeBarbearia(p)).includes(q) || servicosDe(p.id).some(s => norm(s.nome).includes(q)));
  $('barbersSub').textContent = l.length === 1 ? '1 profissional disponível.' : `${l.length} profissionais disponíveis.`;
  $('barbersList').innerHTML = l.length ? l.map(p => {
    const tags = servicosDe(p.id).slice(0, 2).map((s, i) => `<i class="tag ${i ? 'plain' : ''}">${esc(s.nome)}</i>`).join('')
      + (p.atendeDomicilio ? '<i class="tag plain">Em casa</i>' : '');
    return `<button class="barber" data-act="abrirPro" data-id="${esc(p.id)}"><span class="pic ph ph-face initials">${esc(inic(p.nome))}</span>
      <span style="flex:1;min-width:0"><h3>${esc(p.nome)}</h3><div class="sub">${esc(subPro(p))}</div><span class="tags">${tags}</span></span></button>`;
  }).join('') : '<div class="empty">Nenhum profissional encontrado.</div>';
}

function renderMeus(){
  renderBell();
  const prox = S.agds.filter(proximo), ant = S.agds.filter(a => !proximo(a)).reverse();
  $('meusProx').innerHTML = prox.length ? prox.map(a => cardAgdCliente(a, true)).join('') : '<div class="empty">Nenhum horário marcado.</div>';
  $('meusAnt').innerHTML = ant.length ? ant.map(a => cardAgdCliente(a, false)).join('') : '<div class="empty">Nada por aqui ainda.</div>';
}

/* ---------------------------------------------------------------------
   CLIENTE — perfil do barbeiro e agendamento
   --------------------------------------------------------------------- */
async function abrirPro(id, remarcar){
  const p = S.pros.find(x => x.id === id);
  if(!p) return toast('Profissional não encontrado.');
  S.origem = S.tela === 's-barber' ? S.origem : S.tela;
  S.pro = p; S.agendaPro = null; S.remarcando = remarcar || null;
  S.sel = { servicoId: remarcar ? remarcar.servicoId : null, dia: null, hora: null, dom: false };
  S.ocupados = new Set(); S.calRef = new Date(); S.calRef.setDate(1);
  document.querySelectorAll('#s-barber .tab').forEach((t, i) => t.classList.toggle('on', i === 1));
  document.querySelectorAll('#s-barber .tabpanel').forEach(x => x.classList.toggle('on', x.id === 'p-agenda'));
  show('s-barber');
  try{
    const [ag, sv] = await Promise.all([
      FB.getDoc(FB.doc(db, 'agendas', id)),
      FB.getDocs(FB.query(FB.collection(db, 'servicos'), FB.where('profissionalId', '==', id)))
    ]);
    if(S.pro !== p) return;
    S.agendaPro = { horarios: { ...HORARIOS_PADRAO, ...((ag.exists() && ag.data().horarios) || {}) } };
    S.servicos = S.servicos.filter(s => s.profissionalId !== id).concat(docs(sv));
  }catch(e){
    console.error(e); toast(msgErro(e));
    if(S.pro !== p) return;
    S.agendaPro = { horarios: { ...HORARIOS_PADRAO } };
  }
  if(!S.sel.servicoId) S.sel.servicoId = (servicosDe(id)[0] || {}).id || null;
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

function primeiroDiaLivre(){
  const sv = servicoSel(), dur = sv ? sv.duracaoMin : SLOT_MIN;
  const agora = new Date(), min = agora.getHours() * 60 + agora.getMinutes();
  for(let i = 0; i < 62; i++){
    const d = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + i);
    const h = S.agendaPro.horarios[DIAS[d.getDay()]];
    const slots = geraSlots(h, dur).filter(t => i > 0 || toMin(t) > min);
    if(slots.length) return ymd(d);
  }
  return null;
}

function renderBarber(){
  const p = S.pro; if(!p) return;
  $('bName').textContent = p.nome; $('bSub').textContent = subPro(p); $('bAvatar').textContent = inic(p.nome);
  const bn = $('bBanner');
  bn.hidden = !S.remarcando;
  if(S.remarcando) bn.textContent = 'Remarcando: escolha o novo dia e horário e confirme no botão abaixo.';

  const svs = servicosDe(p.id);
  $('svcList').innerHTML = svs.length ? svs.map(s =>
    `<button class="svc ${s.id === S.sel.servicoId ? 'on' : ''}" data-act="svc" data-id="${esc(s.id)}"><span class="mark">✓</span>
     <span class="n"><b>${esc(s.nome)}</b><span>${esc(s.duracaoMin)} min</span></span><span class="p">${dinheiro(s.precoBase)}</span></button>`).join('')
    : '<div class="empty">Este profissional ainda não cadastrou serviços.</div>';

  $('domCard').hidden = !p.atendeDomicilio || !!S.remarcando;
  $('domTxt').textContent = `${primeiroNome(p.nome)} vai até você por ${dinheiro(TAXA_DOMICILIO)}`;
  $('domSw').classList.toggle('on', S.sel.dom);

  // sobre
  $('bSobre').textContent = p.sobre || 'Este profissional ainda não escreveu a apresentação.';
  $('bMetrics').innerHTML =
    `<div class="metric"><span>Serviços</span><b>${svs.length}</b><small>cadastrados</small></div>
     <div class="metric"><span>Atende em casa</span><b>${p.atendeDomicilio ? 'Sim' : 'Não'}</b><small>${p.atendeDomicilio ? dinheiro(TAXA_DOMICILIO) + ' de deslocamento' : 'só na barbearia'}</small></div>`;
  const b = p.barbeariaId && S.barbearias[p.barbeariaId];
  const end = b ? [b.logradouro, b.bairro, b.complemento].filter(Boolean).join(', ') : '';
  const horas = S.agendaPro
    ? ORDEM_SEMANA.map(i => { const h = S.agendaPro.horarios[DIAS[i]]; return h && h.aberto ? `${DIAS_NOME[i]}: ${esc(h.inicio)} às ${esc(h.fim)}` : null; }).filter(Boolean).join('<br>')
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
    const hor = S.agendaPro && S.agendaPro.horarios[DIAS[dt.getDay()]];
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
async function ocupadosDoDia(pid, dia, ignorarAgdId){
  const k = dia.replace(/-/g, ''), ocup = new Set();
  const snap = await FB.getDocs(FB.query(FB.collection(db, 'horariosOcupados'),
    FB.where(FB.documentId(), '>=', `${pid}_${k}_0000`),
    FB.where(FB.documentId(), '<=', `${pid}_${k}_2359`)));
  snap.docs.forEach(d => {
    if(ignorarAgdId && d.data().agendamentoId === ignorarAgdId) return;
    ocup.add(horaDoId(d.id));
  });
  return ocup;
}

async function carregarSlots(){
  const dia = S.sel.dia, pid = S.pro && S.pro.id, req = ++S.slotReq;
  if(!dia || !pid){ S.ocupados = new Set(); renderSlots(); renderResumo(); return; }
  $('slots').innerHTML = '<p class="tiny muted" style="grid-column:1/-1">Carregando horários…</p>';
  let ocup = new Set();
  try{ ocup = await ocupadosDoDia(pid, dia, S.remarcando && S.remarcando.id); }
  catch(e){ console.error(e); toast(msgErro(e)); }
  if(req !== S.slotReq) return;
  S.ocupados = ocup;
  renderSlots(); renderResumo();
}

function renderSlots(){
  const box = $('slots');
  if(!S.agendaPro || !S.sel.dia){
    $('dayLabel').textContent = '—';
    box.innerHTML = `<p class="tiny muted" style="grid-column:1/-1">${S.agendaPro ? 'Este profissional não tem dias livres nos próximos meses.' : 'Carregando…'}</p>`;
    return;
  }
  const d = parseYmd(S.sel.dia);
  $('dayLabel').textContent = `${DIAS_ABREV[d.getDay()]}, ${d.getDate()}`;
  const sv = servicoSel(), dur = sv ? sv.duracaoMin : SLOT_MIN;
  const cands = candidatosDoDia(S.agendaPro.horarios, S.sel.dia, dur);
  const livre = t => slotLivre(t, dur, S.ocupados);
  if(S.sel.hora && !(cands.includes(S.sel.hora) && livre(S.sel.hora))) S.sel.hora = null;
  box.innerHTML = cands.length
    ? cands.map(t => `<button class="slot ${t === S.sel.hora ? 'on' : ''}" ${livre(t) ? '' : 'disabled'} data-act="slot" data-id="${t}">${t}</button>`).join('')
    : '<p class="tiny muted" style="grid-column:1/-1">Sem horários livres nesse dia.</p>';
}

function renderResumo(){
  const sv = servicoSel(), dom = S.sel.dom && S.pro && S.pro.atendeDomicilio && !S.remarcando;
  $('sSvc').textContent = sv ? sv.nome : 'Escolha um serviço';
  $('sWhen').textContent = S.sel.dia ? `${dataCurta(S.sel.dia)} · ${S.sel.hora || '—'}` : '—';
  $('sDur').textContent = sv ? `${sv.duracaoMin} min` : '—';
  $('rowDom').style.display = dom ? 'flex' : 'none';
  $('sDomTaxa').textContent = dinheiro(TAXA_DOMICILIO);
  const total = sv ? dinheiro(+sv.precoBase + (dom ? TAXA_DOMICILIO : 0)) : '—';
  $('sTotal').textContent = total; $('sTotal2').textContent = total;
  $('btnConfirmar').textContent = S.remarcando ? 'Confirmar remarcação' : 'Confirmar agendamento';
}
function domic(el){ S.sel.dom = el.classList.contains('on'); renderResumo(); }

const enderecoTexto = p => `${p.logradouroResidencia}${p.complementoResidencia ? ' - ' + p.complementoResidencia : ''}, ${p.bairroResidencia} — CEP ${p.cepResi}`;

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
  const pid = pro.id, uid = S.user.uid;
  const ref = FB.doc(FB.collection(db, 'agendamentos'));
  const dados = {
    localAtendimento: dom ? 'DOMICILIO' : 'BARBEARIA',
    clienteId: uid, clienteNome: S.perfil.nome,
    data: dia, horario: hora,
    profissionalId: pid, servicoId: sv.id, agendaId: pid,
    status: 'PENDENTE', criadoEm: FB.serverTimestamp()
  };
  if(dom) dados.enderecoCliente = enderecoTexto(S.perfil);
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
  const a = S.remarcando;
  if(!S.sel.dia || !S.sel.hora) return toast('Escolha o novo dia e horário.');
  await comBotao('btnConfirmar', async () => {
    const sv = servicoPorId(a.servicoId), dur = sv ? sv.duracaoMin : SLOT_MIN;
    const pid = a.profissionalId, uid = S.user.uid;
    const antigos = await slotsDoAgendamento(a.id);
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

// quem = 'cliente' | 'pro'
async function mudarStatus(id, status, quem){
  const a = S.agds.find(x => x.id === id); if(!a) return;
  const sv = servicoPorId(a.servicoId), quando = `${dataCurta(a.data)} às ${a.horario}`;
  const batch = FB.writeBatch(db);
  batch.update(FB.doc(db, 'agendamentos', id), { status });
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
  $('meAvatar').textContent = inic(p.nome);
  $('meEmail').textContent = (S.user && S.user.email) || '';
  const m = { 'me-nome':'nome', 'me-tel':'telefone', 'me-cpf':'cpf', 'me-cnpj':'cnpj', 'me-rua':'logradouroResidencia',
              'me-cep':'cepResi', 'me-bairro':'bairroResidencia', 'me-comp':'complementoResidencia', 'me-cond':'condicao' };
  Object.entries(m).forEach(([id, k]) => $(id).value = p[k] || '');
  $('me-uf').value = p.estado || '';
}
async function salvarPerfil(){
  const d = {
    nome: val('me-nome'), telefone: val('me-tel'), estado: $('me-uf').value, cpf: val('me-cpf'), cnpj: val('me-cnpj'),
    logradouroResidencia: val('me-rua'), bairroResidencia: val('me-bairro'), cepResi: val('me-cep'),
    complementoResidencia: val('me-comp'), condicao: val('me-cond')
  };
  const completo = !!(d.nome && d.telefone && d.estado && (d.cpf || d.cnpj) && d.logradouroResidencia && d.bairroResidencia && d.cepResi);
  await comBotao('meBtn', async () => {
    const antes = !!S.perfil.perfilCompleto;
    await FB.updateDoc(FB.doc(db, 'clientes', S.user.uid), { ...d, perfilCompleto: completo });
    S.perfil = { ...S.perfil, ...d, perfilCompleto: completo };
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
    acts = (comeco ? `<button class="btn btn-gold btn-sm" data-act="pConcluir" data-id="${esc(a.id)}">Concluir</button>` : '')
         + `<button class="btn btn-danger btn-sm" data-act="pCancelar" data-id="${esc(a.id)}">Cancelar</button>`;
  return `<div class="acard"><div class="top"><span class="ic">${ICON_CAL}</span>
    <span class="tx"><b>${esc(a.clienteNome || 'Cliente')}</b>
    <span>${esc(sv ? sv.nome : 'Serviço removido')} · ${esc(dataCurta(a.data))} · ${esc(a.horario)}</span>
    ${a.localAtendimento === 'DOMICILIO' ? `<span>Em casa: ${esc(a.enderecoCliente || 'endereço não informado')}</span>` : ''}</span>
    <span class="st ${st.c}">${st.t}</span></div>${acts ? `<div class="acts">${acts}</div>` : ''}</div>`;
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
   PROFISSIONAL — painel (perfil, serviços, horários, barbearia)
   --------------------------------------------------------------------- */
function fillPro(){
  const p = S.perfil || {}, v = S.privado || {};
  $('prAvatar').textContent = inic(p.nome); $('prNome').textContent = p.nome || '—'; $('prSub').textContent = subPro(p);
  $('pr-nome').value = p.nome || ''; $('pr-tel').value = p.telefone || ''; $('pr-uf').value = p.estado || '';
  $('pr-sobre').value = p.sobre || '';
  $('pr-dom').classList.toggle('on', !!p.atendeDomicilio);
  $('prDomTxt').textContent = `Cobra ${dinheiro(TAXA_DOMICILIO)} por deslocamento`;
  const m = { 'pr-cpf':'cpf', 'pr-cnpj':'cnpj', 'pr-rua':'logradouroResidencia', 'pr-cep':'cepResi', 'pr-bairro':'bairroResidencia', 'pr-comp':'complementoResidencia' };
  Object.entries(m).forEach(([id, k]) => $(id).value = v[k] || '');
  renderHoras(); renderServicosPro();
  $('pr-barb').innerHTML = '<option value="">Nenhuma (autônomo)</option>'
    + Object.values(S.barbearias).sort((a,b) => (a.nome||'').localeCompare(b.nome||'')).map(b => `<option value="${esc(b.id)}">${esc(b.nome)}</option>`).join('')
    + '<option value="__nova">+ Cadastrar nova barbearia</option>';
  $('pr-barb').value = (p.barbeariaId && S.barbearias[p.barbeariaId]) ? p.barbeariaId : '';
  barbSelecionada();
}

function renderHoras(){
  $('prHoras').innerHTML = ORDEM_SEMANA.map(i => {
    const k = DIAS[i], h = S.horariosPro[k] || HORARIOS_PADRAO[k];
    return `<div class="hour ${h.aberto ? '' : 'fechado'}" data-dia="${k}"><span class="d">${DIAS_NOME[i]}</span>
      <div class="switch ${h.aberto ? 'on' : ''}" data-act="horaSw" aria-label="${DIAS_NOME[i]} aberto"></div>
      <input type="time" value="${esc(h.inicio)}" aria-label="Abre"><span class="sep">até</span><input type="time" value="${esc(h.fim)}" aria-label="Fecha"></div>`;
  }).join('');
}
function coletarHoras(){
  const out = {};
  for(const row of document.querySelectorAll('#prHoras .hour')){
    const [a, b] = row.querySelectorAll('input'), aberto = row.querySelector('.switch').classList.contains('on');
    if(aberto && (!a.value || !b.value || toMin(a.value) >= toMin(b.value)))
      throw new Error(`Confira o horário de ${DIAS_NOME[DIAS.indexOf(row.dataset.dia)]}: a abertura deve ser antes do fechamento.`);
    out[row.dataset.dia] = { aberto, inicio: a.value || '09:00', fim: b.value || '18:00' };
  }
  return out;
}

function barbSelecionada(){
  const v = $('pr-barb').value, uid = S.user && S.user.uid, b = S.barbearias[v];
  const meu = v === '__nova' || (b && b.donoId === uid);
  $('barbForm').hidden = !meu;
  if(v === '__nova'){ ['bb-nome','bb-cnpj','bb-rua','bb-bairro','bb-comp'].forEach(i => $(i).value = ''); }
  else if(meu){ $('bb-nome').value = b.nome || ''; $('bb-cnpj').value = b.cnpj || ''; $('bb-rua').value = b.logradouro || ''; $('bb-bairro').value = b.bairro || ''; $('bb-comp').value = b.complemento || ''; }
  $('barbHint').textContent = v === '__nova' ? 'Você será o responsável por esta barbearia e poderá editar os dados dela.'
    : meu ? 'Você é o responsável por esta barbearia.'
    : v ? 'Você aparecerá como profissional desta barbearia.' : 'Sem barbearia: você aparece como profissional independente.';
}

async function salvarPro(){
  const uid = S.user.uid;
  const d = { nome: val('pr-nome'), telefone: val('pr-tel'), estado: $('pr-uf').value, sobre: val('pr-sobre').slice(0, 280), atendeDomicilio: $('pr-dom').classList.contains('on') };
  const priv = { cpf: val('pr-cpf'), cnpj: val('pr-cnpj'), logradouroResidencia: val('pr-rua'), cepResi: val('pr-cep'), bairroResidencia: val('pr-bairro'), complementoResidencia: val('pr-comp') };
  if(!d.nome || !d.telefone || !d.estado) return toast('Preencha nome, telefone e estado.');
  if(!priv.cpf && !priv.cnpj) return toast('Informe o CPF ou o CNPJ.');
  if(!priv.logradouroResidencia || !priv.cepResi || !priv.bairroResidencia) return toast('Preencha o endereço (rua, CEP e bairro).');
  let horarios;
  try{ horarios = coletarHoras(); }catch(e){ return toast(e.message, 3800); }
  const sel = $('pr-barb').value;
  const criaOuEdita = sel === '__nova' || (S.barbearias[sel] && S.barbearias[sel].donoId === uid);
  if(criaOuEdita && (!val('bb-nome') || !val('bb-cnpj'))) return toast('Informe o nome e o CNPJ da barbearia.');

  await comBotao('prBtn', async () => {
    const batch = FB.writeBatch(db);
    let barbeariaId = sel && sel !== '__nova' ? sel : null, novaB = null;
    if(criaOuEdita){
      const ref = sel === '__nova' ? FB.doc(FB.collection(db, 'barbearias')) : FB.doc(db, 'barbearias', sel);
      novaB = { nome: val('bb-nome'), cnpj: val('bb-cnpj'), logradouro: val('bb-rua'), bairro: val('bb-bairro'), complemento: val('bb-comp'), donoId: uid };
      batch.set(ref, novaB);
      barbeariaId = ref.id; novaB.id = ref.id;
    }
    batch.set(FB.doc(db, 'profissionais', uid), { ...d, barbeariaId }, { merge: true });
    batch.set(FB.doc(db, 'profissionais', uid, 'privado', 'dados'), priv);
    batch.set(FB.doc(db, 'agendas', uid), { profissionalId: uid, horarios }, { merge: true });
    await batch.commit();
    S.perfil = { ...S.perfil, ...d, barbeariaId };
    S.privado = priv; S.horariosPro = horarios;
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
   ASSISTENTE VIRTUAL (chatbot.js)
   Aqui ficam só as "tomadas" que ligam o chatbot aos dados e às funções do app.
   --------------------------------------------------------------------- */
// Texto seguro para o backend do chatbot: só letras, números e " +-()." (até 60 caracteres).
const rotulo = s => String(s ?? '').replace(/[^\p{L}0-9 +\-().]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const limita = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(+n) ? +n : min));
const limiteAgenda = () => { const h = new Date(); return new Date(h.getFullYear(), h.getMonth() + JANELA_MESES + 1, 0); };

// O que o backend recebe junto com as mensagens: profissionais, serviços, horários e os horários marcados do cliente.
function contextoIA(){
  const professionals = S.pros.slice(0, 20).map(p => {
    const name = rotulo(p.nome); if(!name) return null;
    const barbershop = rotulo(nomeBarbearia(p));
    const ag = S.agendas[p.id] || {};
    const hours = ORDEM_SEMANA.map(i => ({ day: DIAS[i], h: ag[DIAS[i]] }))
      .filter(x => x.h && x.h.aberto && /^\d{2}:\d{2}$/.test(x.h.inicio) && /^\d{2}:\d{2}$/.test(x.h.fim))
      .map(x => ({ day: x.day, start: x.h.inicio, end: x.h.fim }));
    const services = servicosDe(p.id).slice(0, 10)
      .map(s => ({ name: rotulo(s.nome), minutes: Math.round(limita(s.duracaoMin, 1, 1000)), price: Math.round(limita(s.precoBase, 0, 100000) * 100) / 100 }))
      .filter(s => s.name);
    return { name, ...(barbershop ? { barbershop } : {}), homeService: !!p.atendeDomicilio, hours, services };
  }).filter(Boolean);
  const appointments = S.agds.filter(proximo).slice(0, 20).map(a => {
    const sv = servicoPorId(a.servicoId), pro = S.pros.find(p => p.id === a.profissionalId);
    return { id: a.id, service: rotulo(sv && sv.nome) || 'Serviço', barber: rotulo(pro && pro.nome) || 'Profissional', date: a.data, time: a.horario, status: a.status };
  }).filter(a => /^[A-Za-z0-9]{4,28}$/.test(a.id) && /^\d{4}-\d{2}-\d{2}$/.test(a.date) && /^\d{2}:\d{2}$/.test(a.time));
  return { appointments, shop: { homeFee: TAXA_DOMICILIO, bookingUntil: ymd(limiteAgenda()), professionals } };
}

function criarAssistente(){
  bot = criarChatbot({
    SLOT_MIN, taxaDomicilio: TAXA_DOMICILIO, dataCurta, dinheiro,
    apiUrl: () => CHAT_URL,
    nomeCliente: () => (S.perfil && S.perfil.nome) ? primeiroNome(S.perfil.nome) : '',
    perfilCompleto: () => !!(S.perfil && S.perfil.perfilCompleto),
    profissionais: () => S.pros,
    servicosDe,
    proximos: () => S.agds.filter(proximo).map(a => {
      const sv = servicoPorId(a.servicoId), pro = S.pros.find(p => p.id === a.profissionalId), st = STATUS[a.status] || { t: a.status };
      return { id: a.id, servico: sv ? sv.nome : 'Serviço removido', profissional: pro ? pro.nome : 'Profissional',
               quando: `${dataCurta(a.data)} às ${a.horario}`, status: st.t, domicilio: a.localAtendimento === 'DOMICILIO', pode: ativo(a) && futuro(a) };
    }),
    hoje: () => ymd(new Date()),
    limite: () => ymd(limiteAgenda()),
    carregarAgenda: async pid => {
      const ag = await FB.getDoc(FB.doc(db, 'agendas', pid));
      return { ...HORARIOS_PADRAO, ...((ag.exists() && ag.data().horarios) || {}) };
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
  's-pagenda': () => renderPAgenda(),
  's-pro':     () => fillPro()
};
// telas que se atualizam sozinhas quando o Firestore avisa de mudanças (não inclui telas com formulário)
const LIVE = { 's-home': renderHome, 's-barbers': renderBarbers, 's-meus': renderMeus, 's-pagenda': renderPAgenda };

const ACTS = {
  destaque:   id => { S.destaque = id; renderHome(); },
  abrirPro:   id => abrirPro(id),
  svc:        id => {
    if(S.remarcando) return toast('Para trocar o serviço, cancele este horário e agende de novo.', 3400);
    S.sel.servicoId = id; renderBarber();
  },
  dia:        id => { S.sel.dia = id; S.sel.hora = null; renderCal(); carregarSlots(); },
  slot:       id => { S.sel.hora = id; renderSlots(); renderResumo(); },
  remarcar:   id => { const a = S.agds.find(x => x.id === id); if(a) return abrirPro(a.profissionalId, a); },
  cancelarCli:id => { if(confirm('Cancelar este horário?')) return mudarStatus(id, 'CANCELADO', 'cliente'); },
  pConfirmar: id => mudarStatus(id, 'CONFIRMADO', 'pro'),
  pConcluir:  id => mudarStatus(id, 'CONCLUIDO', 'pro'),
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
  voltarBarber, mesCal, domic, confirmar, salvarPerfil, salvarServico, limparServico, salvarPro, barbSelecionada
});

/* dots do carrossel da home */
(function(){
  const rail = $('rail');
  rail.addEventListener('scroll', () => {
    const i = Math.round(rail.scrollLeft / (rail.scrollWidth / 3));
    document.querySelectorAll('.dots .dot').forEach((d, n) => d.classList.toggle('on', n === i));
  }, { passive: true });
})();

/* ---------------------------------------------------------------------
   início
   --------------------------------------------------------------------- */
['cp-uf','me-uf','pr-uf'].forEach(popularUF);

criarAssistente();

(async function init(){
  // URL do backend do chatbot (opcional): sem ela o assistente funciona só pelos botões do menu
  try{ CHAT_URL = String((await import('./chatbot-config.js')).chatbotApiUrl || '').trim(); }catch(e){ console.warn('chatbot-config.js não encontrado'); }
  if(!await initFirebase()){ hideBoot(); return; }
  FB.onAuthStateChanged(auth, async user => {
    if(S.autenticando) return;                         // login/cadastro em andamento: ele mesmo abre a tela
    if(!user){ if(S.sessaoUid) logoutView(); hideBoot(); return; }
    if(S.sessaoUid === user.uid){ hideBoot(); return; }
    try{ await iniciarSessao(user); }
    catch(e){ console.error(e); logoutView(); toast(msgErro(e), 4200); }
    hideBoot();
  });
})();
