/*
 * Storage for the Flux scheduling page.
 *
 * On claude.ai the page uses the artifact's shared database (`db`
 * capability). Outside claude.ai (opening dist/index.html locally, or a
 * viewer who isn't signed in) it falls back to this browser's storage so
 * the screens still work for testing; a banner says nothing is shared.
 *
 * Collections:
 *   campaigns/{id}   name, dates, targets, rounds, settings
 *   people/{id}      roster: name, team, roles, aliases, active, email
 *   snapshots/{id}   one saved availability poll (dated, per campaign)
 *   candidates/{id}  candidate record with its step timeline
 *   invites/{id}     a request to an interviewer to hold a slot for a candidate's round
 *   availability/{personId}  half-day availability Natalie (or the person) set by hand; newest answer wins
 *   notes/{id}       a note or interview feedback on a candidate, by Natalie or an interviewer
 *   members/{userId} a team member said "I'm in" on the welcome card (each person writes their own)
 *   inbox/{userId}   what one interviewer sees: their requests, interviews, briefs, own scores (written by Natalie's page)
 *   replies/{userId} an interviewer's answers and feedback, applied to invites and notes by Natalie's page
 *   stats/{campaignId} campaign overview and team scoreboard everyone can read
 *   reports/{id}     feedback report (note, screenshot, app context) for the developer
 */
(function (root) {
  'use strict';

  const COLLECTIONS = ['campaigns', 'people', 'snapshots', 'candidates', 'notes', 'invites', 'availability', 'members', 'inbox', 'replies', 'stats', 'reports'];
  // What an advisor or team lead's page loads; the rest is Natalie's.
  const VIEWER_COLLECTIONS = ['campaigns', 'stats'];
  const LOCAL_KEY = 'flux-scheduling-local-v1';

  function uid(prefix) {
    return `${prefix || ''}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function createLocalBackend() {
    let data = {};
    try {
      data = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') || {};
    } catch (e) {
      data = {};
    }
    for (const c of COLLECTIONS) data[c] = data[c] || {};
    const listeners = {};
    function persist() {
      try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
      } catch (e) {
        /* storage blocked: keep in memory */
      }
    }
    function emit(coll) {
      const docs = Object.entries(data[coll]).map(([id, d]) => ({ id, ...d }));
      (listeners[coll] || []).forEach((fn) => fn(docs));
    }
    return {
      mode: 'local',
      subscribe(coll, fn) {
        (listeners[coll] = listeners[coll] || []).push(fn);
        setTimeout(() => emit(coll), 0);
      },
      watchDoc(coll, id, fn) {
        const send = () => fn(data[coll][id] ? { id, ...data[coll][id] } : null);
        (listeners[coll] = listeners[coll] || []).push(send);
        setTimeout(send, 0);
      },
      async set(coll, id, doc) {
        data[coll][id] = JSON.parse(JSON.stringify(doc));
        persist();
        emit(coll);
      },
      async update(coll, id, patch) {
        data[coll][id] = { ...(data[coll][id] || {}), ...JSON.parse(JSON.stringify(patch)) };
        persist();
        emit(coll);
      },
      async get(coll, id) {
        return data[coll][id] ? { id, ...data[coll][id] } : null;
      },
      async remove(coll, id) {
        delete data[coll][id];
        persist();
        emit(coll);
      },
    };
  }

  function createDbBackend(db) {
    return {
      mode: 'db',
      subscribe(coll, fn, onError) {
        db.collection(coll).onSnapshot(
          (snap) => fn(snap.docs.filter((d) => d.exists).map((d) => ({ id: d.id, ...d.data() }))),
          (err) => onError && onError(coll, err),
        );
      },
      watchDoc(coll, id, fn, onError) {
        const ref = db.collection(coll).doc(id);
        if (typeof ref.onSnapshot === 'function') {
          ref.onSnapshot(
            (d) => fn(d.exists ? { id: d.id, ...d.data() } : null),
            (err) => onError && onError(coll, err),
          );
          return;
        }
        const poll = () => ref.get().then((d) => fn(d.exists ? { id: d.id, ...d.data() } : null), (err) => onError && onError(coll, err));
        poll();
        setInterval(poll, 30000);
      },
      set(coll, id, doc) {
        return db.collection(coll).doc(id).set(strip(doc));
      },
      update(coll, id, patch) {
        return db.collection(coll).doc(id).update(strip(patch));
      },
      remove(coll, id) {
        return db.collection(coll).doc(id).delete();
      },
      async get(coll, id) {
        const d = await db.collection(coll).doc(id).get();
        return d.exists ? { id: d.id, ...d.data() } : null;
      },
    };
  }

  // Never write the `id` field into the body; drop undefined values.
  function strip(doc) {
    const { id, ...rest } = doc;
    return JSON.parse(JSON.stringify(rest));
  }

  /**
   * Connect and keep `state` (one array per collection) up to date.
   * Calls `onChange(collection)` after each update.
   */
  async function connect(onChange, onError) {
    let backend = null;
    let user = null;
    try {
      if (root.claude && typeof root.claude.use === 'function') {
        const [db, u] = await Promise.all([root.claude.use('db'), root.claude.use('user')]);
        user = u;
        if (db) backend = createDbBackend(db);
      }
    } catch (e) {
      backend = null;
    }
    if (!backend) backend = createLocalBackend();
    // Editors (Natalie) get the whole app; everyone else gets the interviewer page.
    let admin = true;
    if (user && typeof user.canEdit === 'function') {
      try {
        admin = (await user.canEdit()) !== false;
      } catch (e) {
        admin = true;
      }
    }
    let myId = null;
    if (user && typeof user.id === 'function') {
      try {
        myId = await user.id();
      } catch (e) {
        myId = null;
      }
    }
    const state = { loaded: {}, mine: { inbox: undefined, replies: undefined } };
    for (const c of COLLECTIONS) state[c] = [];
    if (!admin) {
      const key = myId || 'local';
      for (const coll of ['inbox', 'replies']) {
        backend.watchDoc(
          coll,
          key,
          (doc) => {
            state.mine[coll] = doc;
            onChange(coll);
          },
          onError,
        );
      }
    }
    for (const c of admin ? COLLECTIONS : VIEWER_COLLECTIONS) {
      backend.subscribe(
        c,
        (docs) => {
          state[c] = docs;
          state.loaded[c] = true;
          onChange(c);
        },
        onError,
      );
    }
    return {
      mode: backend.mode,
      admin,
      myId,
      user,
      state,
      uid,
      add(coll, doc) {
        const id = uid(coll.slice(0, 2) + '_');
        return backend.set(coll, id, doc).then(() => id);
      },
      set: (coll, id, doc) => backend.set(coll, id, doc),
      update: (coll, id, patch) => backend.update(coll, id, patch),
      remove: (coll, id) => backend.remove(coll, id),
      get: (coll, id) => backend.get(coll, id),
    };
  }

  root.FluxStore = { connect, uid, COLLECTIONS, VIEWER_COLLECTIONS };
})(typeof window !== 'undefined' ? window : globalThis);
