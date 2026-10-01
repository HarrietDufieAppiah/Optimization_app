/* In-memory stand-in for Supabase, used only when config.js is left in DEMO mode.
   Nothing is saved; reloading the page clears everything. */
window.makeDemoClient = function () {
  let session = null;
  const users = {};
  const listeners = [];
  const now = Date.now();
  const jobs = [
    { id: "demo-0002-5e1f", title: "Example job (in progress)", scenario: "Restaurant", status: "running",
      created_at: new Date(now - 2 * 864e5).toISOString(), result_files: [], admin_message: null,
      inputs: { changed_keys: [] } },
    { id: "demo-0001-a7c3", title: "Example job (finished)", scenario: "Household", status: "done",
      created_at: new Date(now - 9 * 864e5).toISOString(),
      result_files: [{ name: "report.pdf", path: "demo/report.pdf" }, { name: "pareto_points.csv", path: "demo/pareto_points.csv" }],
      admin_message: "Demo result. In the live site your files appear here.", inputs: { changed_keys: [] } },
  ];
  const emit = (evt) => listeners.forEach((cb) => cb(evt, session));
  const wait = () => new Promise((r) => setTimeout(r, 250));
  const makeSession = (email, meta) => ({ user: { id: "demo-user", email, user_metadata: meta || {} } });

  return {
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithPassword({ email, password }) {
        await wait();
        if (!email || !password) return { error: { message: "Invalid login credentials" } };
        session = makeSession(email, (users[email] || {}).meta || { full_name: email.split("@")[0] });
        emit("SIGNED_IN"); return { data: session, error: null };
      },
      async signUp({ email, password, options }) {
        await wait();
        users[email] = { password, meta: (options || {}).data };
        session = makeSession(email, (options || {}).data);
        emit("SIGNED_IN"); return { data: session, error: null };
      },
      async signOut() { session = null; emit("SIGNED_OUT"); return { error: null }; },
      async resetPasswordForEmail() { await wait(); return { error: null }; },
      async updateUser() { await wait(); return { error: null }; },
    },
    from() {
      return {
        insert(row) {
          const r = Object.assign({ id: "demo-" + Math.random().toString(16).slice(2, 10), status: "submitted",
            created_at: new Date().toISOString(), result_files: [], admin_message: null }, row);
          jobs.unshift(r);
          return { select() { return { async single() { await wait(); return { data: r, error: null }; } }; } };
        },
        select() { return { async order() { await wait(); return { data: jobs.slice(), error: null }; } }; },
      };
    },
    storage: {
      from() { return { async createSignedUrl() { return { data: null, error: { message: "Downloads are disabled in demo mode." } }; } }; },
    },
  };
};
