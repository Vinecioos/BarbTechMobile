/* =====================================================================
   BarbTech — recuperacao.js
   Código de recuperação que funciona só no aparelho + Firebase (sem servidor próprio).

   Como funciona:
   1) No cadastro o app gera um código aleatório de 100 bits (20 caracteres, ex.: K7QM-2XW9-HB4T-ZP3D-8RNV).
   2) A senha da conta é criptografada no aparelho com AES-256-GCM, usando uma chave derivada desse código
      (PBKDF2-SHA256, 600 mil voltas). O resultado (o "cofre") é guardado em recuperacao/{e-mail} no Firestore.
   3) Quem esqueceu a senha informa e-mail + código. O app baixa o cofre, tenta abri-lo com o código e, se abrir,
      entra na conta, define a nova senha e gera um código novo (o antigo deixa de valer).

   O Firestore nunca recebe o código nem a senha em texto aberto. Sem o código, o cofre não abre:
   com 100 bits de aleatoriedade e 600 mil voltas de PBKDF2, adivinhar não é viável.
   ===================================================================== */

const ALFABETO = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';   // 30 símbolos, sem 0/O, 1/I/L, U (evita confusão ao copiar)
const VOLTAS = 600000;
const enc = new TextEncoder(), dec = new TextDecoder();

const b64 = u8 => { let s = ''; u8.forEach(b => { s += String.fromCharCode(b); }); return btoa(s); };
const deB64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));

// 20 símbolos sorteados com o gerador seguro do sistema (sem viés: descarta valores fora do múltiplo de 30)
export function gerarCodigo(){
  const lim = 256 - (256 % ALFABETO.length);
  let out = '';
  while(out.length < 20){
    const buf = crypto.getRandomValues(new Uint8Array(32));
    for(const b of buf){ if(b < lim && out.length < 20) out += ALFABETO[b % ALFABETO.length]; }
  }
  return out.match(/.{4}/g).join('-');
}
// aceita minúsculas, espaços e traços de menos ou a mais; devolve só os 20 símbolos
export const normalizarCodigo = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const codigoCompleto = c => { const n = normalizarCodigo(c); return n.length === 20 && [...n].every(ch => ALFABETO.includes(ch)); };

async function chave(codigo, sal){
  const base = await crypto.subtle.importKey('raw', enc.encode(normalizarCodigo(codigo)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: VOLTAS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// monta o documento do cofre (o que vai para o Firestore)
export async function fecharCofre({ email, uid, senha, codigo }){
  email = String(email).toLowerCase();
  const sal = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(email) }, await chave(codigo, sal), enc.encode(senha));
  return { uid, v: 1, sal: b64(sal), iv: b64(iv), ct: b64(new Uint8Array(ct)), criadoEm: new Date().toISOString() };
}

// devolve a senha guardada, ou null se o código estiver errado (ou o cofre foi alterado)
export async function abrirCofre({ email, cofre, codigo }){
  try{
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: deB64(cofre.iv), additionalData: enc.encode(String(email).toLowerCase()) },
      await chave(codigo, deB64(cofre.sal)), deB64(cofre.ct));
    return dec.decode(pt);
  }catch(e){ return null; }
}

// arquivo de texto para o usuário guardar o código
export function baixarCodigo(codigo, email){
  const txt = `BarbTech - código de recuperação da conta\r\n\r\nConta: ${email}\r\nCódigo: ${codigo}\r\n\r\n` +
    'Guarde este arquivo em um lugar seguro (não envie para outras pessoas).\r\n' +
    'Com este código e o seu e-mail você recupera a conta se esquecer a senha.\r\n' +
    'O BarbTech não guarda o código: se perdê-lo, será preciso gerar outro dentro do app.\r\n';
  const nome = 'barbtech-codigo-recuperacao.txt';
  // no celular, o menu "compartilhar" deixa salvar em Arquivos/Drive; no navegador, baixa direto
  try{
    const arq = new File([txt], nome, { type: 'text/plain' });
    if(navigator.canShare && navigator.canShare({ files: [arq] })){ navigator.share({ files: [arq], title: 'Código de recuperação BarbTech' }).catch(() => {}); return; }
  }catch(e){}
  const url = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
