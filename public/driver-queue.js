(function driverQueueModule(scope) {
  'use strict';

  const databaseName = 'delivery-driver-offline-v1';
  const storeName = 'actions';
  const maxItemsPerOwner = 30;
  const maxAgeMs = 24 * 60 * 60 * 1000;
  const supportedTypes = ['transition', 'incident'];

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onerror = () => reject(request.error || new Error('Stockage local indisponible.'));
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.createObjectStore(storeName, { keyPath: 'idempotencyKey' });
        store.createIndex('ownerCreated', ['owner', 'createdAt']);
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function useStore(mode, operation) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let result;
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || new Error('Stockage local indisponible.'));
        transaction.onabort = () => reject(transaction.error || new Error('Écriture locale interrompue.'));
        Promise.resolve(operation(store)).then((value) => { result = value; }).catch((error) => {
          reject(error);
          transaction.abort();
        });
      });
    } finally {
      database.close();
    }
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Lecture locale impossible.'));
    });
  }

  function validateAction(action) {
    if (!action || !supportedTypes.includes(action.type)) throw new Error('Cette action ne peut pas être conservée hors ligne.');
    if (!action.owner || !action.orderId || !action.idempotencyKey || !action.payload) throw new Error('Action hors ligne incomplète.');
    const expectedPath = `/api/driver/orders/${encodeURIComponent(action.orderId)}/${action.type === 'transition' ? 'transition' : 'incidents'}`;
    if (action.url !== expectedPath) throw new Error('Destination hors ligne non autorisée.');
  }

  async function list(owner) {
    if (!owner) return [];
    const items = await useStore('readonly', (store) => requestResult(store.getAll()));
    return items.filter((item) => item.owner === owner).sort((a, b) => a.createdAt - b.createdAt);
  }

  async function remove(idempotencyKey) {
    return useStore('readwrite', (store) => requestResult(store.delete(idempotencyKey)));
  }

  async function update(item) {
    return useStore('readwrite', (store) => requestResult(store.put(item)));
  }

  async function clearOwner(owner) {
    const items = await list(owner);
    await Promise.all(items.map((item) => remove(item.idempotencyKey)));
  }

  async function purgeExpired(owner, now = Date.now()) {
    const items = await list(owner);
    const expired = items.filter((item) => now - item.createdAt > maxAgeMs);
    await Promise.all(expired.map((item) => remove(item.idempotencyKey)));
    return expired.length;
  }

  async function enqueue(action) {
    validateAction(action);
    await purgeExpired(action.owner);
    const current = await list(action.owner);
    if (current.length >= maxItemsPerOwner) throw new Error('La file hors ligne est pleine. Reconnectez-vous avant de poursuivre.');
    if (action.type === 'transition' && current.some((item) => item.type === 'transition' && String(item.orderId) === String(action.orderId))) {
      throw new Error('Une mise à jour de cette livraison attend déjà la synchronisation.');
    }
    const item = {
      type: action.type,
      owner: action.owner,
      orderId: String(action.orderId),
      url: action.url,
      payload: action.payload,
      idempotencyKey: action.idempotencyKey,
      createdAt: Date.now(),
      status: 'pending',
      error: null,
      attempts: 0,
    };
    await update(item);
    return item;
  }

  async function resumeSessionItems(owner) {
    const items = await list(owner);
    await Promise.all(items.filter((item) => item.status === 'attention' && item.errorCode === 'session_expired').map((item) => update({
      ...item, status: 'pending', error: null, errorCode: null,
    })));
  }

  async function flush({ owner, fetchImpl = fetch, now = Date.now() }) {
    const expired = await purgeExpired(owner, now);
    const items = (await list(owner)).filter((item) => item.status === 'pending');
    const result = { sent: 0, expired, attention: 0, remaining: items.length, stopped: false };
    for (const item of items) {
      const attempted = { ...item, attempts: item.attempts + 1, lastAttemptAt: now };
      try {
        const response = await fetchImpl(item.url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Offline-Replay': '1' },
          body: JSON.stringify(item.payload),
        });
        if (response.ok) {
          await remove(item.idempotencyKey);
          result.sent += 1;
          result.remaining -= 1;
          continue;
        }
        const payload = await response.json().catch(() => ({}));
        if ([400, 401, 403, 404, 409, 422].includes(response.status)) {
          await update({
            ...attempted,
            status: 'attention',
            error: payload.error || `Action refusée (${response.status}).`,
            errorCode: response.status === 401 ? 'session_expired' : 'server_rejected',
          });
          result.attention += 1;
          result.stopped = true;
          break;
        }
        await update({ ...attempted, error: payload.error || 'Serveur temporairement indisponible.' });
        result.stopped = true;
        break;
      } catch (_error) {
        await update({ ...attempted, error: 'Connexion indisponible. Nouvelle tentative à la reconnexion.' });
        result.stopped = true;
        break;
      }
    }
    return result;
  }

  scope.DriverQueue = {
    enqueue, list, remove, clearOwner, flush, purgeExpired, resumeSessionItems,
    maxItemsPerOwner, maxAgeMs,
  };
}(typeof self !== 'undefined' ? self : window));
