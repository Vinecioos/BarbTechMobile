/* =====================================================================
   BarbTech — chatbot.js
   Assistente virtual dentro do app (só para clientes).

   O que ele faz:
     • Agendar horário, Ver disponibilidade e Meus agendamentos (cancelar/remarcar):
       usam os MESMOS dados e regras do resto do app (Firestore), por meio das
       funções que o app.js passa em "api".
     • Perguntas livres (cortes, barba, preços, horários...): vão para o backend em
       backend-chatbot/ (a chave da OpenAI fica só lá). Sem URL configurada em
       chatbot-config.js, ele responde apenas pelos botões.

   Este arquivo não conhece o Firebase: tudo que precisa vem de "api".
   ===================================================================== */

const ESPERA = ms => new Promise(r => setTimeout(r, ms));
const PARA_SEMPRE = () => new Promise(() => {});   // usado para abandonar conversas antigas (ex.: depois de sair da conta)

export function criarChatbot(api){
  const $ = id => document.getElementById(id);
  const el = { launcher: $('bb-launcher'), panel: $('bb-panel'), close: $('bb-close'),
               msgs: $('bb-messages'), form: $('bb-form'), input: $('bb-input'), send: $('bb-send') };
  if(!el.launcher || !el.panel || !el.msgs || !el.form) return { visivel(){}, fechar(){}, resetar(){} };

  let sessao = 0;          // muda ao sair da conta: respostas atrasadas de conversas antigas são descartadas
  let fluxo = 0;           // muda a cada novo fluxo: botões antigos deixam de valer
  let aberto = false, mostrar = false, iniciado = false;
  let historico = [], ocupadoIA = false;

  /* ---------------------------------------------------------------
     interface
     --------------------------------------------------------------- */
  const rolar = () => { el.msgs.scrollTop = el.msgs.scrollHeight; };

  function linha(classe, texto){
    const row = document.createElement('div');
    row.className = 'bb-row ' + classe;
    const b = document.createElement('div');
    b.className = 'bb-bubble';
    b.textContent = texto;               // textContent: nada digitado por usuários vira HTML
    row.appendChild(b);
    el.msgs.appendChild(row);
    rolar();
    return row;
  }
  const bot = t => linha('bb-bot', t);
  const eu = t => linha('bb-me', t);

  function digitando(){
    const row = document.createElement('div');
    row.className = 'bb-row bb-bot';
    row.innerHTML = '<div class="bb-bubble"><div class="bb-typing"><span></span><span></span><span></span></div></div>';
    el.msgs.appendChild(row);
    rolar();
    return row;
  }

  // fala do assistente, com o "digitando..." de um instante
  async function falar(texto, ms = 380){
    const s = sessao, d = digitando();
    await ESPERA(ms);
    if(s !== sessao) return PARA_SEMPRE();
    d.remove();
    bot(texto);
  }

  // Começa um novo fluxo: os botões e campos das etapas anteriores ficam desativados.
  function novoFluxo(){
    fluxo++;
    el.msgs.querySelectorAll('.bb-choices button, .bb-datebox button, .bb-datebox input').forEach(x => { x.disabled = true; });
  }

  // Mostra botões e devolve (numa Promise) o valor do que a pessoa tocar.
  function escolher(opcoes){
    const s = sessao, f = fluxo;
    return new Promise(resolve => {
      const caixa = document.createElement('div');
      caixa.className = 'bb-choices';
      opcoes.forEach(o => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bb-chip' + (o.perigo ? ' bb-chip-danger' : '');
        b.textContent = o.rotulo;
        b.addEventListener('click', () => {
          if(s !== sessao || f !== fluxo) return;
          caixa.querySelectorAll('button').forEach(x => { x.disabled = true; });
          eu(o.rotulo);
          resolve(o.valor);
        });
        caixa.appendChild(b);
      });
      el.msgs.appendChild(caixa);
      rolar();
    });
  }

  // Campo de data (entre hoje e o limite da agenda).
  function perguntarData(){
    const s = sessao, f = fluxo;
    return new Promise(resolve => {
      const min = api.hoje(), max = api.limite();
      const caixa = document.createElement('div');
      caixa.className = 'bb-datebox';
      const inp = document.createElement('input');
      inp.type = 'date'; inp.min = min; inp.max = max; inp.value = min;
      inp.setAttribute('aria-label', 'Data');
      const btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = 'Confirmar';
      btn.addEventListener('click', () => {
        if(s !== sessao || f !== fluxo) return;
        const v = inp.value;
        if(!/^\d{4}-\d{2}-\d{2}$/.test(v) || v < min || v > max){
          bot(`Escolha uma data entre ${api.dataCurta(min)} e ${api.dataCurta(max)}.`);
          return;
        }
        inp.disabled = true; btn.disabled = true;
        eu(api.dataCurta(v));
        resolve(v);
      });
      caixa.append(inp, btn);
      el.msgs.appendChild(caixa);
      rolar();
    });
  }

  /* ---------------------------------------------------------------
     conversa
     --------------------------------------------------------------- */
  async function comecar(){
    const nome = api.nomeCliente(), f = fluxo;
    await falar(`Olá${nome ? ', ' + nome : ''}! Eu sou o assistente virtual da BarbTech.`);
    if(f !== fluxo) return;   // a pessoa já digitou algo durante a saudação
    return menu();
  }

  async function menu(intro = 'Como posso ajudar? Use os botões ou digite sua dúvida sobre cortes, barba e agendamentos.'){
    await falar(intro);
    const v = await escolher([
      { rotulo: 'Agendar horário', valor: 'agendar' },
      { rotulo: 'Ver disponibilidade', valor: 'disp' },
      { rotulo: 'Meus agendamentos', valor: 'meus' }
    ]);
    novoFluxo();
    if(v === 'agendar') return protegido(() => agendar());
    if(v === 'disp') return protegido(() => disponibilidade());
    return protegido(() => meusAgendamentos());
  }

  // Qualquer erro vira uma mensagem simples e volta ao menu (nunca deixa a conversa travada).
  async function protegido(fn){
    try{ return await fn(); }
    catch(e){
      console.error(e);
      await falar(api.erroTexto(e));
      return menu('Posso ajudar com mais alguma coisa?');
    }
  }

  async function perguntarPro(lista){
    await falar('Com qual profissional?');
    return escolher(lista.map(p => ({ rotulo: p.nome || 'Profissional', valor: p })));
  }

  async function horasDoDia(pro, dia, dur){
    const [horarios, ocupados] = await Promise.all([api.carregarAgenda(pro.id), api.carregarOcupados(pro.id, dia)]);
    return api.horasLivres(horarios, dia, dur, ocupados);
  }

  /* ---------- Agendar horário ---------- */
  async function agendar(pre = {}){
    if(!api.perfilCompleto()){
      await falar('Para agendar, primeiro complete seu perfil (nome, telefone, CPF e endereço). Leva um minuto.');
      const v = await escolher([{ rotulo: 'Completar meu perfil', valor: 'perfil' }, { rotulo: 'Voltar ao menu', valor: 'menu' }]);
      novoFluxo();
      if(v === 'perfil'){ api.irPara('s-me'); return menu('Quando terminar o perfil, é só voltar aqui. Posso ajudar com mais alguma coisa?'); }
      return menu();
    }
    const comServico = api.profissionais().filter(p => api.servicosDe(p.id).length);
    if(!comServico.length){
      await falar('Ainda não há profissionais com serviços cadastrados. Volte em breve!');
      return menu();
    }

    const pro = pre.pro || await perguntarPro(comServico);
    const servicos = api.servicosDe(pro.id);
    if(!servicos.length){
      await falar(`${pro.nome} ainda não cadastrou serviços.`);
      return menu();
    }

    await falar('Qual serviço você deseja?');
    const sv = await escolher(servicos.map(s => ({ rotulo: `${s.nome} · ${s.duracaoMin} min · ${api.dinheiro(s.precoBase)}`, valor: s })));

    let dom = false;
    if(pro.atendeDomicilio){
      await falar('Onde será o atendimento?');
      dom = await escolher([
        { rotulo: 'Na barbearia', valor: false },
        { rotulo: `Em casa (+ ${api.dinheiro(api.taxaDomicilio)})`, valor: true }
      ]);
    }

    let dia = pre.dia || null;
    for(;;){
      if(!dia){ await falar('Para qual dia? Escolha no calendário abaixo.'); dia = await perguntarData(); }
      const horas = await horasDoDia(pro, dia, sv.duracaoMin);

      if(!horas.length){
        await falar(`${pro.nome} não tem horário livre para ${sv.nome} em ${api.dataCurta(dia)}. O que prefere?`);
        const v = await escolher([
          { rotulo: 'Escolher outra data', valor: 'data' },
          { rotulo: 'Trocar profissional', valor: 'pro' },
          { rotulo: 'Cancelar', valor: 'cancelar' }
        ]);
        novoFluxo();
        if(v === 'data'){ dia = null; continue; }
        if(v === 'pro') return agendar();
        return menu('Sem problemas, ficamos por aqui.');
      }

      await falar(`Horários livres com ${pro.nome} em ${api.dataCurta(dia)}:`);
      const hora = await escolher([...horas.map(t => ({ rotulo: t, valor: t })), { rotulo: 'Outra data', valor: null }]);
      if(hora === null){ dia = null; continue; }

      const total = Number(sv.precoBase) + (dom ? api.taxaDomicilio : 0);
      await falar(
        'Confirme o agendamento:\n\n' +
        `Serviço: ${sv.nome} (${sv.duracaoMin} min)\n` +
        `Profissional: ${pro.nome}\n` +
        `Data: ${api.dataCurta(dia)} às ${hora}\n` +
        `Local: ${dom ? 'Em casa (endereço do seu perfil)' : 'Na barbearia'}\n` +
        `Total: ${api.dinheiro(total)}`
      );
      const v = await escolher([{ rotulo: 'Confirmar agendamento', valor: 'sim' }, { rotulo: 'Cancelar', valor: 'nao' }]);
      novoFluxo();
      if(v === 'nao') return menu('Agendamento não confirmado. Se mudar de ideia, é só chamar.');

      try{
        await api.reservar({ pro, sv, dia, hora, dom });
      }catch(e){
        if(e && e.code === 'permission-denied'){
          await falar('Esse horário acabou de ser ocupado por outra pessoa. Vamos escolher outro.');
          continue;
        }
        throw e;
      }
      await falar('Pedido enviado! O profissional vai confirmar o seu horário e você será avisado aqui no app.');
      const p = await escolher([{ rotulo: 'Ver meus horários', valor: 'ver' }, { rotulo: 'Voltar ao menu', valor: 'menu' }]);
      novoFluxo();
      if(p === 'ver'){ api.irPara('s-meus'); return menu('Posso ajudar com mais alguma coisa?'); }
      return menu();
    }
  }

  /* ---------- Ver disponibilidade ---------- */
  async function disponibilidade(){
    const pros = api.profissionais();
    if(!pros.length){
      await falar('Ainda não há profissionais cadastrados.');
      return menu();
    }
    const pro = await perguntarPro(pros);
    await falar('Para qual dia? Escolha no calendário abaixo.');
    const dia = await perguntarData();
    const horas = await horasDoDia(pro, dia, api.SLOT_MIN);
    await falar(horas.length
      ? `${pro.nome} tem estes horários livres em ${api.dataCurta(dia)}:\n\n${horas.join('  ·  ')}`
      : `${pro.nome} não tem horários livres em ${api.dataCurta(dia)}.`);
    const v = await escolher([{ rotulo: 'Agendar agora', valor: 'agendar' }, { rotulo: 'Voltar ao menu', valor: 'menu' }]);
    novoFluxo();
    if(v === 'agendar') return agendar({ pro, dia });
    return menu();
  }

  /* ---------- Meus agendamentos ---------- */
  async function meusAgendamentos(){
    const lista = api.proximos();
    if(!lista.length){
      await falar('Você não tem horários marcados no momento.');
      return menu();
    }
    await falar(lista.length === 1 ? 'Você tem 1 horário marcado:' : `Você tem ${lista.length} horários marcados:`);
    for(const a of lista){
      await falar(`${a.servico} com ${a.profissional}\n${a.quando} · ${a.status}${a.domicilio ? '\nAtendimento em casa' : ''}`, 250);
    }
    const gerenciaveis = lista.filter(a => a.pode);
    if(!gerenciaveis.length) return menu();

    await falar('Quer remarcar ou cancelar algum?');
    const a = await escolher([
      ...gerenciaveis.map(x => ({ rotulo: `${x.servico} · ${x.quando}`, valor: x })),
      { rotulo: 'Voltar ao menu', valor: null }
    ]);
    novoFluxo();
    if(!a) return menu();

    await falar(`${a.servico} com ${a.profissional}, ${a.quando}. O que deseja fazer?`);
    const acao = await escolher([
      { rotulo: 'Remarcar', valor: 'remarcar' },
      { rotulo: 'Cancelar horário', valor: 'cancelar', perigo: true },
      { rotulo: 'Voltar', valor: 'voltar' }
    ]);
    novoFluxo();
    if(acao === 'voltar') return menu();
    if(acao === 'remarcar'){
      await falar('Abrindo a agenda para você escolher o novo dia e horário.', 250);
      api.remarcar(a.id);
      return;
    }
    await falar('Tem certeza que quer cancelar este horário?');
    const c = await escolher([{ rotulo: 'Sim, cancelar', valor: 'sim', perigo: true }, { rotulo: 'Não', valor: 'nao' }]);
    novoFluxo();
    if(c !== 'sim') return menu('Tudo bem, o horário foi mantido.');
    await api.cancelar(a.id);
    await falar('Horário cancelado. O profissional foi avisado.');
    return menu();
  }

  /* ---------- Perguntas livres (IA, via backend) ---------- */
  async function perguntarIA(texto){
    if(ocupadoIA) return;
    novoFluxo();   // botões antigos deixam de valer (evita menus duplicados)
    const s = sessao;
    const url = api.apiUrl();
    if(!url){
      await falar('Ainda não consigo responder perguntas digitadas, mas posso ajudar pelos botões do menu.');
      return menu('Como posso ajudar?');
    }
    ocupadoIA = true; el.send.disabled = true;
    historico.push({ role: 'user', content: texto.slice(0, 500) });
    const d = digitando();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    let resposta = null, falhou = null;
    try{
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', signal: ctrl.signal,
        body: JSON.stringify({ messages: historico.slice(-10), ...api.contextoIA() })
      });
      if(!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if(typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('resposta inválida');
      resposta = data.reply;
    }catch(e){
      falhou = e;
    }finally{
      clearTimeout(timer);
    }
    if(s !== sessao) return;           // saiu da conta durante a espera
    d.remove();
    ocupadoIA = false; el.send.disabled = false;
    if(resposta !== null){
      historico.push({ role: 'assistant', content: resposta });
      bot(resposta);
    }else{
      historico.pop();
      console.warn('chatbot:', falhou && falhou.message);
      bot(falhou && falhou.message === '429'
        ? 'Você enviou muitas mensagens seguidas. Aguarde um instante e tente de novo.'
        : 'Não consegui responder agora. Tente novamente em instantes ou use os botões do menu.');
    }
    if(aberto && matchMedia('(hover: hover)').matches) el.input.focus();
    const v = await escolher([{ rotulo: 'Agendar horário', valor: 'agendar' }, { rotulo: 'Menu principal', valor: 'menu' }]);
    novoFluxo();
    if(v === 'agendar') return protegido(() => agendar());
    return menu();
  }

  el.form.addEventListener('submit', e => {
    e.preventDefault();
    const texto = el.input.value.trim();
    if(!texto || ocupadoIA) return;
    el.input.value = '';
    eu(texto);
    novoFluxo();
    perguntarIA(texto);
  });

  /* ---------------------------------------------------------------
     abrir / fechar / visibilidade
     --------------------------------------------------------------- */
  function atualizarLauncher(){ el.launcher.hidden = !mostrar || aberto; }

  function abrir(){
    if(!mostrar) return;
    aberto = true;
    el.panel.hidden = false;
    atualizarLauncher();
    if(!iniciado){ iniciado = true; comecar(); }
    if(matchMedia('(hover: hover)').matches) el.input.focus();   // no celular não abre o teclado sozinho
  }
  function fechar(){
    if(!aberto) return;
    aberto = false;
    el.panel.hidden = true;
    atualizarLauncher();
  }

  el.launcher.addEventListener('click', abrir);
  el.close.addEventListener('click', fechar);
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && aberto) fechar(); });

  return {
    // o app diz em que telas o botão do assistente aparece
    visivel(v){ mostrar = !!v; if(!mostrar) fechar(); atualizarLauncher(); },
    fechar,
    // ao sair da conta: apaga a conversa e esquece tudo
    resetar(){
      sessao++; fluxo++;
      el.msgs.innerHTML = '';
      historico = []; ocupadoIA = false; iniciado = false;
      el.send.disabled = false; el.input.value = '';
      mostrar = false; fechar(); atualizarLauncher();
    }
  };
}
