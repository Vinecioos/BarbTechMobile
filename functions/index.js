// BarbTech — envia a notificação push para o celular quando nasce um documento em "notificacoes".
// Plano Blaze do Firebase é obrigatório para publicar Cloud Functions (há cota gratuita mensal).
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();

// TROQUE pela MESMA região do seu Firestore (Console → Firestore → aba Dados, no topo: "Local").
// Exemplos: 'southamerica-east1' (São Paulo), 'us-central1', 'nam5' usa 'us-central1'.
const REGION = 'southamerica-east1';

const INVALIDOS = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];

exports.enviarPush = onDocumentCreated({ document: 'notificacoes/{id}', region: REGION }, async event => {
  const n = event.data && event.data.data();
  if (!n || !n.destinatarioId || !n.mensagem) return;

  const db = getFirestore();
  const snap = await db.collection('dispositivos').where('uid', '==', n.destinatarioId).get();
  const docs = snap.docs.filter(d => d.data().token);
  if (!docs.length) return;

  const res = await getMessaging().sendEachForMulticast({
    tokens: docs.map(d => d.data().token),
    notification: { title: 'BarbTech', body: String(n.mensagem).slice(0, 180) },
    data: { agendamentoId: String(n.agendamentoId || ''), tipo: String(n.tipo || '') },
    android: { priority: 'high' }
  });

  // remove do banco os celulares que não existem mais (app desinstalado)
  const apagar = [];
  res.responses.forEach((r, i) => {
    if (!r.success && r.error && INVALIDOS.includes(r.error.code)) apagar.push(docs[i].ref.delete());
  });
  await Promise.all(apagar);
});
