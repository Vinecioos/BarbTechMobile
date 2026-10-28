// Armazenamento simples (coleção/id → objeto). Em produção usa o Firestore pelo Admin SDK; nos testes, memória.
export function storeMemoria() {
  const m = new Map();
  const col = (c) => { if (!m.has(c)) m.set(c, new Map()); return m.get(c); };
  let seq = 0;
  return {
    async get(c, id) { const v = col(c).get(id); return v ? structuredClone(v) : null; },
    async set(c, id, o) { col(c).set(id, structuredClone(o)); },
    async del(c, id) { col(c).delete(id); },
    async add(c, o) { const id = String(++seq); col(c).set(id, structuredClone(o)); return id; },
    async list(c) { return [...col(c).entries()].map(([id, v]) => ({ id, ...structuredClone(v) })); },
  };
}

export function storeFirestore(db) {
  return {
    async get(c, id) { const s = await db.collection(c).doc(id).get(); return s.exists ? s.data() : null; },
    async set(c, id, o) { await db.collection(c).doc(id).set(o); },
    async del(c, id) { await db.collection(c).doc(id).delete(); },
    async add(c, o) { const r = await db.collection(c).add(o); return r.id; },
    async list(c) { const s = await db.collection(c).get(); return s.docs.map((d) => ({ id: d.id, ...d.data() })); },
  };
}
