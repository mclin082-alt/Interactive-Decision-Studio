const DEFAULT_STATE = {
  users: [],
  sessions: {},
  decks: [],
  logs: [],
  usageEvents: [],
  verificationTokens: [],
  signupVerificationTokens: []
};

const templates = [
  { id: 'sakura-chroma', slug: 'sakura-chroma', name: 'Sakura Chroma', category: 'Design & creative', accent: '#E54489', uses: 2150, deckPath: '/ai-creation-sakura-chroma.html' },
  { id: 'soft-editorial', slug: 'soft-editorial', name: 'Soft Editorial', category: 'General', accent: '#D7DE62', uses: 9602, deckPath: '/ai-notes-launch.html' },
  { id: 'blue-professional', slug: 'blue-professional', name: 'Blue Professional', category: 'Go-to-market', accent: '#3F8BC4', uses: 1888, deckPath: '/ai-creation-sakura-chroma.html' },
  { id: 'creative-mode', slug: 'creative-mode', name: 'Creative Mode', category: 'Design & creative', accent: '#F09131', uses: 1470, deckPath: '/ai-creation-sakura-chroma.html' },
  { id: 'long-table', slug: 'long-table', name: 'Long Table', category: 'Product research', accent: '#3D9F47', uses: 843, deckPath: '/ai-notes-launch.html' },
  { id: 'job-candidate', slug: 'sakura-chroma', name: 'Job Case Study', category: 'Job & career', accent: '#E5392A', uses: 522, deckPath: '/ai-creation-sakura-chroma.html' }
];

const artifactTypes = [
  {
    id: 'product-launch',
    name: 'Product launch',
    focus: 'Turn a product announcement into an interactive launch presentation with demo states, proof, audience-specific value, and rollout story.'
  },
  {
    id: 'fundraising-pitch',
    name: 'Fundraising pitch',
    focus: 'Turn a startup narrative into a web-native investor pitch with market insight, product demo, traction, model, roadmap, and ask.'
  },
  {
    id: 'sales-demo',
    name: 'Sales demo',
    focus: 'Create a buyer-facing interactive sales presentation that moves from pain to proof to product walkthrough to ROI and rollout.'
  },
  {
    id: 'strategy-review',
    name: 'Strategy review',
    focus: 'Make a decision-oriented strategy presentation with choices, tradeoffs, scenarios, risks, metrics, and next moves.'
  },
  {
    id: 'ai-project-showcase',
    name: 'AI project showcase',
    focus: 'Show an AI project as a working narrative: user problem, model/workflow, architecture, evals, risks, and outcome.'
  },
  {
    id: 'portfolio-case-study',
    name: 'Portfolio case study',
    focus: 'Show a product/design/AI project as an interactive case study with problem, process, demo, decisions, outcomes, and reflection.'
  },
  {
    id: 'data-story',
    name: 'Data story',
    focus: 'Build a data-heavy narrative that guides the audience through benchmarks, patterns, implications, and action.'
  },
  {
    id: 'sales-narrative',
    name: 'Sales narrative',
    focus: 'Create a sales artifact that moves from pain to proof to product walkthrough to buyer-specific next steps.'
  }
];

const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      await ensureState(env);
      if (String(env.SEED_DEMO || 'true').toLowerCase() !== 'false') {
        ctx.waitUntil(seedDemoData(env).catch((error) => console.error('Demo seed failed', error)));
      }
      if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
      if (url.pathname.startsWith('/generated/')) return handleGenerated(request, env);
      if (['/ai-creation-sakura-chroma.html', '/ai-creation-sakura-chroma-edited.html', '/ai-notes-launch.html'].includes(url.pathname)) {
        return htmlResponse(publicSampleHtml(url.pathname));
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || 'Server error.' }, 500);
    }
  }
};

async function ensureState(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare('INSERT OR IGNORE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
    .bind('db', JSON.stringify(DEFAULT_STATE), new Date().toISOString())
    .run();
}

async function readDb(env) {
  const row = await env.DB.prepare('SELECT value FROM app_state WHERE key = ?').bind('db').first();
  const parsed = row?.value ? JSON.parse(row.value) : {};
  return normalizeDbShape(parsed);
}

async function writeDb(env, db) {
  await env.DB.prepare('UPDATE app_state SET value = ?, updated_at = ? WHERE key = ?')
    .bind(JSON.stringify(normalizeDbShape(db)), new Date().toISOString(), 'db')
    .run();
}

function normalizeDbShape(db = {}) {
  return {
    users: Array.isArray(db.users) ? db.users : [],
    sessions: db.sessions && typeof db.sessions === 'object' ? db.sessions : {},
    decks: Array.isArray(db.decks) ? db.decks : [],
    logs: Array.isArray(db.logs) ? db.logs : [],
    usageEvents: Array.isArray(db.usageEvents) ? db.usageEvents : [],
    verificationTokens: Array.isArray(db.verificationTokens) ? db.verificationTokens : [],
    signupVerificationTokens: Array.isArray(db.signupVerificationTokens) ? db.signupVerificationTokens : []
  };
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const route = url.pathname.slice('/api'.length) || '/';
  const method = request.method.toUpperCase();

  if (method === 'GET' && route === '/health') return json({ ok: true, app: 'Slide Studio', runtime: 'cloudflare', time: new Date().toISOString() });
  if (method === 'GET' && route === '/templates') return json({ templates, artifactTypes });
  if (method === 'GET' && route === '/me') return withState(request, env, async ({ db, user }) => json({ user: publicUser(user), quota: usageSummaryForUser(db, user, request) }));
  if (method === 'POST' && route === '/logs') return handleLog(request, env);
  if (method === 'POST' && route === '/signup') return handleSignup(request, env);
  if (method === 'GET' && route === '/signup-token') return handleSignupToken(request, env);
  if (method === 'POST' && route === '/signup/complete') return handleSignupComplete(request, env);
  if (method === 'GET' && route === '/verify-email') return handleVerifyEmail(request, env);
  if (method === 'POST' && route === '/resend-verification') return handleResendVerification(request, env);
  if (method === 'POST' && route === '/login') return handleLogin(request, env);
  if (method === 'POST' && route === '/logout') return handleLogout(request, env);
  if (method === 'POST' && route === '/generate') return handleGenerate(request, env, ctx);
  if (method === 'GET' && route === '/decks') return handleDecks(request, env);

  const retryMatch = route.match(/^\/generate\/([^/]+)\/retry$/);
  if (method === 'POST' && retryMatch) return handleRetry(request, env, retryMatch[1], ctx);

  const deckMatch = route.match(/^\/decks\/([^/]+)$/);
  if (method === 'GET' && deckMatch) return handleDeck(request, env, deckMatch[1]);

  const htmlDownloadMatch = route.match(/^\/decks\/([^/]+)\/download\/html$/);
  if (method === 'GET' && htmlDownloadMatch) return handleHtmlDownload(request, env, htmlDownloadMatch[1]);

  const pdfExportMatch = route.match(/^\/decks\/([^/]+)\/export\/pdf$/);
  if (method === 'GET' && pdfExportMatch) {
    return json({ error: 'PDF export is not available on Cloudflare Workers because this runtime cannot launch headless Chrome. Download HTML and print to PDF from the browser.' }, 501);
  }

  const messagesMatch = route.match(/^\/decks\/([^/]+)\/messages$/);
  if (method === 'POST' && messagesMatch) return handleMessage(request, env, messagesMatch[1]);

  const undoMatch = route.match(/^\/decks\/([^/]+)\/undo$/);
  if (method === 'POST' && undoMatch) return handleUndo(request, env, undoMatch[1]);

  if (method === 'POST' && route === '/comment') return handleComment(request, env);

  const commentApplyMatch = route.match(/^\/decks\/([^/]+)\/comments\/([^/]+)\/apply$/);
  if (method === 'POST' && commentApplyMatch) return handleApplyComment(request, env, commentApplyMatch[1], commentApplyMatch[2]);

  return json({ error: 'Not found.' }, 404);
}

async function withState(request, env, callback) {
  const db = await readDb(env);
  return callback({ db, user: getUser(request, db) });
}

async function readBody(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) return {};
  return request.json().catch(() => ({}));
}

async function handleLog(request, env) {
  const body = await readBody(request);
  const db = await readDb(env);
  const entry = {
    id: randomId(),
    level: String(body.level || 'info'),
    message: String(body.message || 'Client event'),
    meta: body.meta || {},
    createdAt: new Date().toISOString()
  };
  db.logs.unshift(entry);
  db.logs = db.logs.slice(0, 500);
  await writeDb(env, db);
  return json({ ok: true, entry });
}

async function handleSignup(request, env) {
  const body = await readBody(request);
  const db = await readDb(env);
  const currentUser = getUser(request, db);
  const pendingGuestUserId = currentUser?.isGuest ? currentUser.id : '';
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim() || email.split('@')[0];
  if (!email) return json({ error: 'Email is required.' }, 400);
  if (db.users.some((item) => item.email === email)) return json({ error: 'Email already exists.' }, 409);

  for (const entry of db.signupVerificationTokens) {
    if (entry.email === email && !entry.usedAt) entry.usedAt = new Date().toISOString();
  }
  const verificationLink = createSignupVerification(env, db, { email, name, pendingGuestUserId });
  await writeDb(env, db);
  return json({
    requiresVerification: true,
    verificationLink,
    verificationEmail: createVerificationEmailPreview({ email }, verificationLink)
  });
}

async function handleSignupToken(request, env) {
  const token = new URL(request.url).searchParams.get('token') || '';
  const db = await readDb(env);
  const entry = db.signupVerificationTokens.find((item) => item.token === token);
  if (!entry || entry.usedAt) return json({ error: 'Signup verification link is invalid or already used.' }, 400);
  if (new Date(entry.expiresAt).getTime() < Date.now()) return json({ error: 'Signup verification link has expired.' }, 400);
  if (db.users.some((item) => item.email === entry.email)) return json({ error: 'Email already exists. Please log in.' }, 409);
  return json({ email: entry.email, name: entry.name || entry.email.split('@')[0] });
}

async function handleSignupComplete(request, env) {
  const body = await readBody(request);
  const token = String(body.token || '').trim();
  const password = String(body.password || '');
  const db = await readDb(env);
  const entry = db.signupVerificationTokens.find((item) => item.token === token);
  if (!entry || entry.usedAt) return json({ error: 'Signup verification link is invalid or already used.' }, 400);
  if (new Date(entry.expiresAt).getTime() < Date.now()) return json({ error: 'Signup verification link has expired.' }, 400);
  if (password.length < 6) return json({ error: 'A 6+ character password is required.' }, 400);
  if (db.users.some((item) => item.email === entry.email)) return json({ error: 'Email already exists. Please log in.' }, 409);

  const now = new Date().toISOString();
  const newUser = {
    id: randomId(),
    name: String(body.name || '').trim() || entry.name || entry.email.split('@')[0],
    email: entry.email,
    passwordHash: await hashPassword(password),
    createdAt: now,
    emailVerifiedAt: now,
    credits: numberEnv(env, 'SIGNUP_VERIFIED_CREDITS', 10),
    plan: 'free',
    isGuest: false
  };
  db.users.push(newUser);
  entry.usedAt = now;
  const migration = mergeGuestProjectsIntoUser(db, entry.pendingGuestUserId, newUser);
  const sessionToken = randomToken();
  db.sessions[sessionToken] = { userId: newUser.id, createdAt: now };
  await writeDb(env, db);
  return json({
    user: publicUser(newUser),
    quota: usageSummaryForUser(db, newUser, request),
    migratedDecks: migration.decks
  }, 200, { 'Set-Cookie': sessionCookie(sessionToken) });
}

async function handleVerifyEmail(request, env) {
  const token = new URL(request.url).searchParams.get('token') || '';
  const db = await readDb(env);
  const entry = db.verificationTokens.find((item) => item.token === token);
  if (!entry || entry.usedAt) return htmlResponse('Verification link is invalid or already used.', 400);
  if (new Date(entry.expiresAt).getTime() < Date.now()) return htmlResponse('Verification link has expired.', 400);
  const user = db.users.find((item) => item.id === entry.userId);
  if (!user) return htmlResponse('User not found.', 404);
  entry.usedAt = new Date().toISOString();
  let migratedDecks = 0;
  if (!user.emailVerifiedAt) {
    user.emailVerifiedAt = entry.usedAt;
    user.credits = Number(user.credits || 0) + numberEnv(env, 'SIGNUP_VERIFIED_CREDITS', 10);
    migratedDecks = mergeGuestProjectsIntoUser(db, entry.pendingGuestUserId, user).decks;
  }
  await writeDb(env, db);
  const returnUrl = `${appBaseUrl(env)}?verified=1&migrated=${encodeURIComponent(String(migratedDecks))}`;
  return htmlResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email verified</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,system-ui,sans-serif;color:#25231f;background:#f7f5ef}main{width:min(440px,calc(100vw - 32px));padding:28px;background:#fff;border:1px solid #e8e1d5;border-radius:8px}a{display:inline-flex;align-items:center;height:42px;padding:0 16px;color:#fff;background:#17614f;border-radius:8px;font-weight:800;text-decoration:none}</style></head><body><main><h1>Email verified</h1><p>${escapeHtml(user.email)} now has ${escapeHtml(String(user.credits))} credits.</p><a href="${escapeHtml(returnUrl)}">Return to Slide Studio</a></main><script>setTimeout(()=>{location.href=${JSON.stringify(returnUrl)}},1800)</script></body></html>`);
}

async function handleResendVerification(request, env) {
  const db = await readDb(env);
  const user = getUser(request, db);
  if (!user || user.isGuest) return json({ error: 'Please log in before verifying email.' }, 401);
  if (user.emailVerifiedAt) return json({ user: publicUser(user), alreadyVerified: true });
  const verificationLink = createEmailVerification(env, db, user);
  await writeDb(env, db);
  return json({
    user: publicUser(user),
    requiresVerification: true,
    verificationLink,
    verificationEmail: createVerificationEmailPreview(user, verificationLink)
  });
}

async function handleLogin(request, env) {
  const body = await readBody(request);
  const db = await readDb(env);
  const currentUser = getUser(request, db);
  const pendingGuestUserId = currentUser?.isGuest ? currentUser.id : '';
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const found = db.users.find((item) => item.email === email);
  if (!found || !(await verifyPassword(password, found.passwordHash))) return json({ error: 'Invalid email or password.' }, 401);

  const token = randomToken();
  db.sessions[token] = { userId: found.id, createdAt: new Date().toISOString() };
  const migration = found.emailVerifiedAt ? mergeGuestProjectsIntoUser(db, pendingGuestUserId, found) : { decks: 0 };
  const verificationLink = found.emailVerifiedAt ? '' : createEmailVerification(env, db, found, { pendingGuestUserId });
  await writeDb(env, db);
  return json({
    user: publicUser(found),
    requiresVerification: Boolean(verificationLink),
    verificationLink,
    verificationEmail: verificationLink ? createVerificationEmailPreview(found, verificationLink) : null,
    migratedDecks: migration.decks
  }, 200, { 'Set-Cookie': sessionCookie(token) });
}

async function handleLogout(request, env) {
  const db = await readDb(env);
  const token = parseCookies(request).session;
  if (token) delete db.sessions[token];
  await writeDb(env, db);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

async function handleGenerate(request, env, ctx) {
  const body = await readBody(request);
  const db = await readDb(env);
  let user = getUser(request, db);
  const requestedTemplate = templates.find((item) => item.id === body.templateId) || templates[0];
  const basicTemplates = basicTrialTemplateIds(env);
  const template = (!user || user.isGuest) && !basicTemplates.has(requestedTemplate.id)
    ? templates.find((item) => basicTemplates.has(item.id)) || requestedTemplate
    : requestedTemplate;
  const artifactType = getArtifactType(body.artifactTypeId);
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return json({ error: 'Prompt is required.' }, 400);

  const responseHeaders = new Headers();
  if (!user) user = await createGuestUserAndSession(request, db, responseHeaders);
  const allowance = ensureGenerationAllowance({ request, env, db, user, template, responseHeaders });
  if (allowance.error) return json({ error: allowance.error, user: publicUser(user), quota: usageSummaryForUser(db, user, request) }, allowance.status || 429, responseHeaders);
  allowance.spend();

  const now = new Date().toISOString();
  const deck = {
    id: randomId(),
    userId: user.id,
    prompt: user.isGuest ? `${prompt}\n\nTrial constraint: create a concise basic presentation artifact with no more than 5 slides.` : prompt,
    templateId: template.id,
    templateSlug: template.slug,
    title: prompt.slice(0, 56),
    deckPath: '',
    r2Key: '',
    status: 'generating',
    currentPage: 1,
    targetContext: JSON.stringify({ artifactTypeId: artifactType.id }),
    createdAt: now,
    updatedAt: now,
    completedAt: '',
    error: '',
    comments: [],
    versions: [],
    messages: [
      { id: randomId(), role: 'user', text: prompt, createdAt: now },
      progressMessage('Queued generation task', `Created a ${artifactType.name.toLowerCase()} artifact job.`)
    ]
  };
  db.decks.unshift(deck);
  await writeDb(env, db);

  if (body.async) {
    ctx.waitUntil(runDeckGeneration(env, deck.id));
    return json({ deck: publicDeck(deck), user: publicUser(user), quota: usageSummaryForUser(db, user, request) }, 202, responseHeaders);
  }

  try {
    await runDeckGeneration(env, deck.id);
    const fresh = await readDb(env);
    const updated = fresh.decks.find((item) => item.id === deck.id) || deck;
    return json({ deck: publicDeck(updated), user: publicUser(user), quota: usageSummaryForUser(fresh, user, request) }, 200, responseHeaders);
  } catch (error) {
    deck.status = 'failed';
    deck.error = error.message || 'Generation failed.';
    deck.completedAt = new Date().toISOString();
    await writeDb(env, db);
    return json({ error: deck.error, deck: publicDeck(deck) }, 500, responseHeaders);
  }
}

async function handleRetry(request, env, deckId, ctx) {
  const body = await readBody(request);
  const db = await readDb(env);
  const user = getUser(request, db);
  if (!user) return json({ error: 'Login required.' }, 401);
  const deck = db.decks.find((item) => item.id === deckId && item.userId === user.id);
  if (!deck) return json({ error: 'Deck not found.' }, 404);
  const template = templates.find((item) => item.id === deck.templateId) || templates[0];
  const allowance = ensureGenerationAllowance({ request, env, db, user, template, responseHeaders: new Headers() });
  if (allowance.error) return json({ error: allowance.error, deck: publicDeck(deck), quota: usageSummaryForUser(db, user, request) }, allowance.status || 429);
  allowance.spend();
  deck.status = 'generating';
  deck.error = '';
  deck.completedAt = '';
  deck.updatedAt = new Date().toISOString();
  deck.messages = (deck.messages || []).filter((message) => message.role !== 'progress');
  deck.messages.push(progressMessage('Queued retry task', 'Restarted generation for this deck.'));
  await writeDb(env, db);
  if (body.async) {
    ctx.waitUntil(runDeckGeneration(env, deck.id));
    return json({ deck: publicDeck(deck) }, 202);
  }
  await runDeckGeneration(env, deck.id);
  const fresh = await readDb(env);
  return json({ deck: publicDeck(fresh.decks.find((item) => item.id === deck.id) || deck) });
}

async function handleDecks(request, env) {
  const db = await readDb(env);
  const user = getUser(request, db);
  if (!user) return json({ error: 'Login required.' }, 401);
  return json({ decks: db.decks.filter((deck) => deck.userId === user.id).map(publicDeck) });
}

async function handleDeck(request, env, deckId) {
  const db = await readDb(env);
  const user = getUser(request, db);
  if (!user) return json({ error: 'Login required.' }, 401);
  const deck = db.decks.find((item) => item.id === deckId && item.userId === user.id);
  if (!deck) return json({ error: 'Deck not found.' }, 404);
  return json({ deck: publicDeck(deck) });
}

async function handleGenerated(request, env) {
  const deckId = new URL(request.url).pathname.match(/^\/generated\/([^/]+)\.html$/)?.[1] || '';
  const db = await readDb(env);
  const user = getUser(request, db);
  if (!user) return htmlResponse('Login required.', 401);
  const deck = db.decks.find((item) => item.id === deckId && item.userId === user.id);
  if (!deck || deck.status !== 'complete' || !deck.r2Key) return htmlResponse('Deck not found.', 404);
  const object = await env.DECKS.get(deck.r2Key);
  if (!object) return htmlResponse('Deck HTML file is missing.', 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function handleHtmlDownload(request, env, deckId) {
  const db = await readDb(env);
  const user = getUser(request, db);
  if (!user) return json({ error: 'Login required.' }, 401);
  const deck = db.decks.find((item) => item.id === deckId && item.userId === user.id);
  if (!deck || !deck.r2Key) return json({ error: 'Deck not found.' }, 404);
  const object = await env.DECKS.get(deck.r2Key);
  if (!object) return json({ error: 'Deck HTML file is missing.' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${sanitizeFileName(deck.title)}.html"`,
      'Cache-Control': 'no-store'
    }
  });
}

async function handleMessage(request, env, deckId) {
  const body = await readBody(request);
  const db = await readDb(env);
  const user = getUser(request, db);
  if (!user) return json({ error: 'Login required.' }, 401);
  const deck = db.decks.find((item) => item.id === deckId && item.userId === user.id);
  if (!deck) return json({ error: 'Deck not found.' }, 404);
  const instruction = String(body.text || '').trim();
  const currentPage = Number(body.currentPage || deck.currentPage || 1);
  if (!instruction) return json({ error: 'Message text is required.' }, 400);
  const currentHtml = await readDeckHtml(env, deck);
  if (!currentHtml) return json({ error: 'Deck HTML file is missing.' }, 404);

  await saveDeckVersion(env, deck, currentHtml, `Before chat edit: ${instruction.slice(0, 48)}`);
  deck.messages ||= [];
  deck.messages.push({ id: randomId(), role: 'user', text: instruction, page: currentPage, createdAt: new Date().toISOString() });
  deck.status = 'editing';
  deck.currentPage = currentPage;
  await writeDb(env, db);

  try {
    const updatedHtml = await editDeckHtml(env, { deck, currentHtml, instruction, currentPage });
    await env.DECKS.put(deck.r2Key, updatedHtml, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    deck.status = 'complete';
    deck.updatedAt = new Date().toISOString();
    deck.error = '';
    deck.lastAppliedAt = deck.updatedAt;
    deck.messages.push({ id: randomId(), role: 'assistant', text: `Applied the requested edit on slide ${currentPage}.`, page: currentPage, createdAt: deck.updatedAt });
    await writeDb(env, db);
    return json({ deck: publicDeck(deck) });
  } catch (error) {
    deck.status = 'complete';
    deck.error = error.message || 'Edit failed.';
    deck.messages.push({ id: randomId(), role: 'assistant', text: `Edit failed: ${deck.error}`, page: currentPage, createdAt: new Date().toISOString() });
    await writeDb(env, db);
    return json({ error: deck.error, deck: publicDeck(deck) }, 500);
  }
}

async function handleUndo(request, env, deckId) {
  const db = await readDb(env);
  const user = getUser(request, db);
  if (!user) return json({ error: 'Login required.' }, 401);
  const deck = db.decks.find((item) => item.id === deckId && item.userId === user.id);
  if (!deck) return json({ error: 'Deck not found.' }, 404);
  deck.versions ||= [];
  const version = deck.versions.pop();
  if (!version?.r2Key) return json({ error: 'No previous version available.' }, 400);
  const object = await env.DECKS.get(version.r2Key);
  if (!object) return json({ error: 'Previous version file is missing.' }, 404);
  await env.DECKS.put(deck.r2Key, await object.text(), { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  deck.updatedAt = new Date().toISOString();
  deck.status = 'complete';
  deck.error = '';
  deck.messages ||= [];
  deck.messages.push({ id: randomId(), role: 'assistant', text: `Undid: ${version.label || 'previous edit'}.`, createdAt: deck.updatedAt });
  await writeDb(env, db);
  return json({ deck: publicDeck(deck) });
}

async function handleComment(request, env) {
  const body = await readBody(request);
  const db = await readDb(env);
  const user = getUser(request, db);
  if (!user) return json({ error: 'Login required.' }, 401);
  const deck = db.decks.find((item) => item.id === body.deckId && item.userId === user.id);
  if (!deck) return json({ error: 'Deck not found.' }, 404);
  const comment = {
    id: randomId(),
    page: Number(body.page || 1),
    note: String(body.note || ''),
    x: Number(body.x || 0),
    y: Number(body.y || 0),
    selector: String(body.selector || ''),
    elementText: String(body.elementText || ''),
    elementTag: String(body.elementTag || ''),
    elementRect: body.elementRect || null,
    status: 'open',
    createdAt: new Date().toISOString()
  };
  deck.comments ||= [];
  deck.comments.push(comment);
  deck.messages ||= [];
  deck.messages.push({ id: randomId(), role: 'user', text: `Annotation on slide ${comment.page}: ${comment.note}`, page: comment.page, createdAt: comment.createdAt });
  deck.messages.push({ id: randomId(), role: 'assistant', text: 'Annotation saved. Applying it to the deck now.', page: comment.page, createdAt: new Date().toISOString() });
  await writeDb(env, db);
  return json({ deck: publicDeck(deck) });
}

async function handleApplyComment(request, env, deckId, commentId) {
  const body = await readBody(request);
  const db = await readDb(env);
  const user = getUser(request, db);
  if (!user) return json({ error: 'Login required.' }, 401);
  const deck = db.decks.find((item) => item.id === deckId && item.userId === user.id);
  if (!deck) return json({ error: 'Deck not found.' }, 404);
  const comment = (deck.comments || []).find((item) => item.id === commentId);
  if (!comment) return json({ error: 'Annotation not found.' }, 404);
  const instruction = String(body.text || comment.note || '').trim();
  if (!instruction) return json({ error: 'Annotation text is required.' }, 400);
  const currentHtml = await readDeckHtml(env, deck);
  if (!currentHtml) return json({ error: 'Deck HTML file is missing.' }, 404);
  const currentPage = Number(comment.page || deck.currentPage || 1);
  await saveDeckVersion(env, deck, currentHtml, `Before annotation: ${instruction.slice(0, 48)}`);
  deck.status = 'editing';
  deck.currentPage = currentPage;
  deck.targetContext = [
    `Annotation id: ${comment.id}`,
    `Slide: ${currentPage}`,
    comment.selector ? `DOM selector: ${comment.selector}` : '',
    comment.elementText ? `Element visible text: ${comment.elementText}` : '',
    `Requested change: ${instruction}`
  ].filter(Boolean).join('\n');
  await writeDb(env, db);

  try {
    const updatedHtml = await editDeckHtml(env, { deck, currentHtml, instruction: `Apply this annotation precisely: ${instruction}`, currentPage });
    await env.DECKS.put(deck.r2Key, updatedHtml, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    comment.status = 'resolved';
    comment.resolvedAt = new Date().toISOString();
    deck.targetContext = '';
    deck.status = 'complete';
    deck.updatedAt = new Date().toISOString();
    deck.error = '';
    deck.messages ||= [];
    deck.messages.push({ id: randomId(), role: 'assistant', text: `Resolved annotation on slide ${currentPage}.`, page: currentPage, createdAt: deck.updatedAt });
    await writeDb(env, db);
    return json({ deck: publicDeck(deck) });
  } catch (error) {
    deck.targetContext = '';
    deck.status = 'complete';
    deck.error = error.message || 'Annotation edit failed.';
    await writeDb(env, db);
    return json({ error: deck.error, deck: publicDeck(deck) }, 500);
  }
}

async function runDeckGeneration(env, deckId) {
  const db = await readDb(env);
  const deck = db.decks.find((item) => item.id === deckId);
  if (!deck) return;
  const user = db.users.find((item) => item.id === deck.userId);
  if (!user) throw new Error('The user for this deck no longer exists.');
  const template = templates.find((item) => item.id === deck.templateId) || templates[0];
  const artifactType = getArtifactType(parseTargetContext(deck.targetContext).artifactTypeId);
  deck.messages ||= [];
  deck.messages.push(progressMessage('Calling the model', `Requesting a structured deck from ${env.OPENAI_PROVIDER || 'OpenAI'} / ${env.OPENAI_MODEL || 'gpt-4.1'}.`, 'active'));
  deck.updatedAt = new Date().toISOString();
  await writeDb(env, db);

  try {
    const html = await generateDeckHtml(env, { prompt: deck.prompt, template, artifactType });
    const key = deckKey(user.id, deck.id);
    await env.DECKS.put(key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    const fresh = await readDb(env);
    const freshDeck = fresh.decks.find((item) => item.id === deck.id);
    if (!freshDeck) return;
    freshDeck.status = 'complete';
    freshDeck.deckPath = `/generated/${deck.id}.html`;
    freshDeck.r2Key = key;
    freshDeck.completedAt = new Date().toISOString();
    freshDeck.updatedAt = freshDeck.completedAt;
    freshDeck.error = '';
    freshDeck.messages ||= [];
    freshDeck.versions ||= [];
    if (!freshDeck.originalR2Key) {
      const originalKey = deckOriginalKey(user.id, deck.id);
      await env.DECKS.put(originalKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
      freshDeck.originalR2Key = originalKey;
    }
    if (!freshDeck.messages.some((message) => message.role === 'assistant')) {
      freshDeck.messages.push({ id: randomId(), role: 'assistant', text: `Generated a real HTML ${artifactType.name.toLowerCase()} artifact with ${template.name}.`, createdAt: freshDeck.updatedAt });
    }
    freshDeck.messages.push(progressMessage('Ready to deliver', 'The artifact is complete. Open it to edit or download HTML.'));
    await writeDb(env, fresh);
  } catch (error) {
    const fresh = await readDb(env);
    const freshDeck = fresh.decks.find((item) => item.id === deck.id);
    if (freshDeck) {
      freshDeck.status = 'failed';
      freshDeck.error = error.message || 'Generation failed.';
      freshDeck.completedAt = new Date().toISOString();
      freshDeck.updatedAt = freshDeck.completedAt;
      freshDeck.messages ||= [];
      freshDeck.messages.push(progressMessage('Generation failed', freshDeck.error, 'failed'));
      await writeDb(env, fresh);
    }
    throw error;
  }
}

async function generateDeckHtml(env, { prompt, template, artifactType }) {
  const modelConfig = getServerModelConfig(env);
  const generationPrompt = buildGenerationPrompt({ prompt, template, artifactType });
  const raw = await callChatCompletions(env, {
    modelConfig,
    maxTokens: numberEnv(env, 'GENERATION_MAX_TOKENS', 6500),
    messages: [
      { role: 'system', content: generationPrompt.system },
      { role: 'user', content: generationPrompt.user }
    ]
  });
  const spec = normalizeDeckSpec(parseJsonObject(raw), prompt, artifactType);
  return renderDeckHtmlFromSpec(spec, template);
}

async function editDeckHtml(env, { deck, currentHtml, instruction, currentPage }) {
  const modelConfig = getServerModelConfig(env);
  const raw = await callChatCompletions(env, {
    modelConfig,
    maxTokens: numberEnv(env, 'EDIT_MAX_TOKENS', 9000),
    messages: [
      {
        role: 'system',
        content: `You are Slide Studio's HTML slide editing engine. Return only one complete updated HTML document. Preserve fixed 1920x1080 .deck-stage structure, inline CSS/JS, navigation, and all <section class="slide"> elements. Apply the requested change directly.`
      },
      {
        role: 'user',
        content: `Instruction: ${instruction}
Current page: ${currentPage || 1}
Target context:
${deck.targetContext || 'None'}

Current HTML:
${currentHtml.length > 90000 ? currentHtml.slice(0, 90000) : currentHtml}`
      }
    ]
  });
  return extractHtml(raw);
}

function buildGenerationPrompt({ prompt, template, artifactType }) {
  return {
    system: `You are Slide Studio's senior presentation designer. Return only valid JSON.

Schema:
{
  "title": "deck title",
  "subtitle": "short framing line",
  "slides": [
    {
      "kicker": "short label",
      "title": "slide title",
      "subtitle": "supporting sentence",
      "layout": "hero | split | metrics | workflow | comparison | chart | roadmap | closing",
      "bullets": ["3 to 5 concise bullets"],
      "metrics": [{"label":"", "value":"", "note":""}],
      "steps": [{"label":"", "title":"", "detail":""}],
      "chart": [{"label":"", "value": 42}],
      "callout": "one crisp insight",
      "speakerNote": "why this slide matters"
    }
  ]
}

Rules:
- Return JSON only. No markdown fences.
- Use 5 to 7 slides unless the user explicitly requests another count.
- Include concrete, presentation-ready copy.
- Include at least one workflow/process slide, one data/chart slide, and one comparison or metrics slide.`,
    user: `User prompt:
${prompt}

Artifact direction:
${artifactType.name}: ${artifactType.focus}

Selected template:
${template.name} (${template.slug})

Create the JSON design spec now.`
  };
}

async function callChatCompletions(env, { modelConfig, messages, maxTokens }) {
  if (!modelConfig.apiKey) throw new Error('The server model API key is not configured yet. Set OPENAI_API_KEY or AI_API_KEY as a Cloudflare secret.');
  const endpoint = `${normalizeBaseUrl(modelConfig.baseUrl)}/chat/completions`;
  const body = {
    model: modelConfig.model,
    messages
  };
  if (/^gpt-5/i.test(modelConfig.model)) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.temperature = 0.72;
    body.max_tokens = maxTokens;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), numberEnv(env, 'AI_REQUEST_TIMEOUT_MS', 120000));
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${modelConfig.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: controller.signal
  }).catch((error) => {
    if (error.name === 'AbortError') throw new Error(`AI API request timed out after ${Math.round(numberEnv(env, 'AI_REQUEST_TIMEOUT_MS', 120000) / 1000)} seconds.`);
    throw error;
  }).finally(() => clearTimeout(timeout));
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_error) {
    data = { error: { message: text } };
  }
  if (!response.ok) throw new Error(data.error?.message || `AI API request failed (${response.status})`);
  const content = data.choices?.[0]?.message?.content || data.output_text || '';
  if (!content) throw new Error('AI API returned an empty response.');
  return content;
}

function renderDeckHtmlFromSpec(spec, template) {
  const theme = themeForTemplate(template);
  const slides = spec.slides.map((slide, index) => renderSlide(slide, index)).join('\n');
  const dots = spec.slides.map((_slide, index) => `<button type="button" data-goto="${index}" aria-label="Go to slide ${index + 1}"></button>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(spec.title)}</title>
  <style>
    :root{--bg:${theme.bg};--surface:${theme.surface};--ink:${theme.ink};--muted:${theme.muted};--accent:${theme.accent};--accent2:${theme.accent2};--accent3:${theme.accent3};}
    *{box-sizing:border-box} html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--bg);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}
    .deck-viewport{position:fixed;inset:0;overflow:hidden;background:var(--bg)} .deck-stage{position:absolute;left:0;top:0;width:1920px;height:1080px;overflow:hidden;transform-origin:0 0;background:var(--surface)}
    .slide{position:absolute;inset:0;width:1920px;height:1080px;padding:74px 86px;overflow:hidden;visibility:hidden;opacity:0;pointer-events:none;background:linear-gradient(135deg,var(--surface),color-mix(in srgb,var(--surface) 82%,var(--accent2)));transition:opacity .28s ease}
    .slide.active,.slide.visible{visibility:visible;opacity:1;pointer-events:auto;z-index:1}
    .slide-chrome{display:flex;justify-content:space-between;align-items:center;font-size:22px;text-transform:uppercase;color:var(--muted);font-weight:800;letter-spacing:0}
    .slide-layout{height:850px;display:grid;grid-template-columns:0.92fr 1.08fr;gap:66px;align-items:center}.slide[data-layout="hero"] .slide-layout,.slide[data-layout="closing"] .slide-layout{grid-template-columns:1fr}.copy-block h1{margin:16px 0 22px;font-size:92px;line-height:.94;letter-spacing:0;max-width:980px}.subtitle{font-size:32px;line-height:1.28;color:var(--muted);max-width:880px}.kicker{margin:0;font-size:22px;text-transform:uppercase;color:var(--accent);font-weight:900}.callout{margin-top:34px;padding:24px 26px;border-left:8px solid var(--accent);background:rgba(255,255,255,.58);font-size:28px;line-height:1.25;font-weight:800}
    .visual-block{min-height:560px;display:grid;gap:24px;align-content:center}.bullet-list{display:grid;gap:18px;margin:0;padding:0;list-style:none}.bullet-list li{padding:22px 24px;background:rgba(255,255,255,.7);border:2px solid rgba(0,0,0,.08);border-radius:8px;font-size:28px;line-height:1.25}.metric-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:22px}.metric-card{padding:28px;background:var(--ink);color:var(--surface);border-radius:8px;min-height:170px}.metric-card span{display:block;color:color-mix(in srgb,var(--surface) 70%,transparent);font-size:20px}.metric-card strong{display:block;margin:16px 0;font-size:62px;line-height:1}.metric-card em{font-style:normal;font-size:22px;color:color-mix(in srgb,var(--surface) 78%,transparent)}
    .stepper{display:grid;grid-template-columns:250px 1fr;gap:20px}.step-buttons{display:grid;gap:12px}.step-buttons button,.deck-controls button,.agenda button{border:0;border-radius:8px;background:var(--ink);color:var(--surface);font-weight:900;font-size:22px;padding:18px;cursor:pointer}.step-buttons button.active,.agenda button.active{background:var(--accent)}.step-panels article{display:none;padding:34px;background:rgba(255,255,255,.74);border:2px solid rgba(0,0,0,.08);border-radius:8px;min-height:360px}.step-panels article.active{display:block}.step-panels b{display:block;font-size:40px;margin-bottom:18px}.step-panels p{font-size:28px;line-height:1.35;color:var(--muted)}
    .bar-chart{display:grid;gap:18px}.bar-row{display:grid;grid-template-columns:210px 1fr 70px;align-items:center;gap:18px;font-size:24px;font-weight:800}.bar-row div{height:30px;background:rgba(0,0,0,.1);border-radius:999px;overflow:hidden}.bar-row i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:999px}
    .speaker-note{position:absolute;left:86px;right:86px;bottom:46px;color:var(--muted);font-size:20px}.deck-controls{position:fixed;left:50%;bottom:22px;z-index:20;transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:10px;background:rgba(0,0,0,.52);border-radius:8px;backdrop-filter:blur(12px)}.deck-controls span{min-width:74px;text-align:center;color:white;font-weight:900}.agenda{position:fixed;right:22px;top:22px;z-index:20;display:flex;gap:8px}.agenda button{width:16px;height:16px;padding:0;border-radius:999px;background:rgba(255,255,255,.45)}
    @media print{html,body{width:1920px;height:auto;overflow:visible;background:white}.deck-viewport,.deck-stage{position:static;transform:none!important;width:1920px;height:auto;overflow:visible}.slide{position:relative;display:block!important;visibility:visible!important;opacity:1!important;page-break-after:always;break-after:page}.deck-controls,.agenda{display:none!important}}
  </style>
</head>
<body>
  <div class="deck-viewport"><div class="deck-stage" id="deckStage">${slides}</div></div>
  <nav class="agenda">${dots}</nav>
  <div class="deck-controls"><button type="button" id="prevSlide">Prev</button><span id="counter">1 / ${spec.slides.length}</span><button type="button" id="nextSlide">Next</button></div>
  <script>
    const stage=document.getElementById('deckStage'); const slides=[...document.querySelectorAll('.slide')]; const counter=document.getElementById('counter'); const dots=[...document.querySelectorAll('[data-goto]')]; let current=0;
    function scaleStage(){const scale=Math.min(innerWidth/1920,innerHeight/1080);stage.style.transform='scale('+scale+')';stage.style.left=((innerWidth-1920*scale)/2)+'px';stage.style.top=((innerHeight-1080*scale)/2)+'px'}
    function show(index){current=Math.max(0,Math.min(slides.length-1,index));slides.forEach((slide,i)=>{slide.classList.toggle('active',i===current);slide.classList.toggle('visible',i===current)});dots.forEach((dot,i)=>dot.classList.toggle('active',i===current));counter.textContent=(current+1)+' / '+slides.length}
    document.getElementById('prevSlide').onclick=()=>show(current-1); document.getElementById('nextSlide').onclick=()=>show(current+1); dots.forEach((dot)=>dot.onclick=()=>show(Number(dot.dataset.goto)||0)); addEventListener('resize',scaleStage); addEventListener('keydown',(event)=>{if(['ArrowRight','PageDown',' '].includes(event.key)){event.preventDefault();show(current+1)} if(['ArrowLeft','PageUp'].includes(event.key))show(current-1)}); document.querySelectorAll('.stepper').forEach((stepper)=>{const buttons=[...stepper.querySelectorAll('[data-step]')];const panels=[...stepper.querySelectorAll('[data-panel]')];buttons.forEach((button)=>button.onclick=()=>{buttons.forEach((item)=>item.classList.toggle('active',item.dataset.step===button.dataset.step));panels.forEach((item)=>item.classList.toggle('active',item.dataset.panel===button.dataset.step))})}); scaleStage(); show(0);
  </script>
</body>
</html>`;
}

function publicSampleHtml(pathname) {
  const isNotes = pathname.includes('notes');
  const template = isNotes ? templates[1] : templates[0];
  const spec = normalizeDeckSpec({
    title: isNotes ? 'AI Notes Product Narrative' : 'AI Creation Tool Launch',
    slides: [
      {
        kicker: 'Sample',
        title: isNotes ? 'Turn messy meetings into launch-ready notes' : 'Create campaign assets from one focused brief',
        subtitle: 'A compact public preview served by the Cloudflare Worker.',
        layout: 'hero',
        bullets: ['Web-native 1920x1080 slides', 'Generated HTML stored in R2 for user decks', 'Editable after generation through chat'],
        callout: 'Sign in to generate and save your own version.'
      },
      {
        kicker: 'Proof',
        title: 'A practical creation loop',
        subtitle: 'Prompt, generate, inspect, edit, and deliver without leaving the browser.',
        layout: 'workflow',
        steps: [
          { label: '1', title: 'Brief', detail: 'Start from a product, story, or portfolio prompt.' },
          { label: '2', title: 'Deck', detail: 'The app renders a complete HTML presentation.' },
          { label: '3', title: 'Edit', detail: 'Use chat and annotations to refine individual slides.' }
        ]
      },
      {
        kicker: 'Stack',
        title: 'Cloudflare storage split',
        subtitle: 'D1 stores state. R2 stores generated presentation files.',
        layout: 'metrics',
        metrics: [
          { label: 'D1', value: 'state', note: 'users, sessions, quotas, deck records' },
          { label: 'R2', value: 'files', note: 'HTML artifacts and edit versions' },
          { label: 'Workers', value: 'API', note: 'generation, auth, and delivery routes' },
          { label: 'Assets', value: 'UI', note: 'built frontend bundle from dist' }
        ]
      }
    ]
  }, 'Sample deck', artifactTypes[0]);
  return renderDeckHtmlFromSpec(spec, template);
}

function renderSlide(slide, index) {
  const body = [
    renderList(slide.bullets),
    renderMetrics(slide.metrics),
    renderSteps(slide.steps),
    renderChart(slide.chart)
  ].filter(Boolean).join('');
  return `<section class="slide ${index === 0 ? 'active visible' : ''}" data-layout="${escapeHtml(slide.layout)}">
    <div class="slide-chrome"><span>${escapeHtml(slide.kicker)}</span><span>${String(index + 1).padStart(2, '0')}</span></div>
    <main class="slide-layout">
      <div class="copy-block"><p class="kicker">${escapeHtml(slide.kicker)}</p><h1>${escapeHtml(slide.title)}</h1>${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ''}${slide.callout ? `<div class="callout">${escapeHtml(slide.callout)}</div>` : ''}</div>
      <div class="visual-block">${body || renderList(['Ready for refinement', 'Use chat edits to tailor this slide', 'Download HTML when finished'])}</div>
    </main>
    ${slide.speakerNote ? `<aside class="speaker-note">${escapeHtml(slide.speakerNote)}</aside>` : ''}
  </section>`;
}

function renderList(items = []) {
  if (!items.length) return '';
  return `<ul class="bullet-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderMetrics(metrics = []) {
  if (!metrics.length) return '';
  return `<div class="metric-grid">${metrics.slice(0, 4).map((item) => `<div class="metric-card"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong><em>${escapeHtml(item.note)}</em></div>`).join('')}</div>`;
}

function renderSteps(steps = []) {
  if (!steps.length) return '';
  return `<div class="stepper"><div class="step-buttons">${steps.slice(0, 5).map((step, index) => `<button type="button" class="${index === 0 ? 'active' : ''}" data-step="${index}">${escapeHtml(step.label)}</button>`).join('')}</div><div class="step-panels">${steps.slice(0, 5).map((step, index) => `<article class="${index === 0 ? 'active' : ''}" data-panel="${index}"><b>${escapeHtml(step.title)}</b><p>${escapeHtml(step.detail)}</p></article>`).join('')}</div></div>`;
}

function renderChart(chart = []) {
  if (!chart.length) return '';
  const max = Math.max(1, ...chart.map((item) => Number(item.value) || 0));
  return `<div class="bar-chart">${chart.slice(0, 6).map((item) => `<div class="bar-row"><span>${escapeHtml(item.label)}</span><div><i style="width:${Math.max(8, Math.round(((Number(item.value) || 0) / max) * 100))}%"></i></div><b>${escapeHtml(item.value)}</b></div>`).join('')}</div>`;
}

function normalizeDeckSpec(rawSpec, prompt, artifactType) {
  const spec = rawSpec && typeof rawSpec === 'object' ? rawSpec : {};
  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  const normalizedSlides = slides.slice(0, 9).map((slide, index) => ({
    kicker: String(slide.kicker || `Slide ${index + 1}`).slice(0, 48),
    title: String(slide.title || `Section ${index + 1}`).slice(0, 96),
    subtitle: String(slide.subtitle || '').slice(0, 220),
    layout: ['hero', 'split', 'metrics', 'workflow', 'comparison', 'chart', 'roadmap', 'closing'].includes(slide.layout) ? slide.layout : 'split',
    bullets: Array.isArray(slide.bullets) ? slide.bullets.slice(0, 5).map((item) => String(item).slice(0, 180)) : [],
    metrics: Array.isArray(slide.metrics) ? slide.metrics.slice(0, 4).map((item) => ({ label: String(item.label || '').slice(0, 44), value: String(item.value || '').slice(0, 32), note: String(item.note || '').slice(0, 90) })) : [],
    steps: Array.isArray(slide.steps) ? slide.steps.slice(0, 5).map((item, stepIndex) => ({ label: String(item.label || `${stepIndex + 1}`).slice(0, 28), title: String(item.title || item.label || `Step ${stepIndex + 1}`).slice(0, 64), detail: String(item.detail || '').slice(0, 180) })) : [],
    chart: Array.isArray(slide.chart) ? slide.chart.slice(0, 6).map((item) => ({ label: String(item.label || '').slice(0, 42), value: Math.max(0, Math.min(100, Number(item.value) || 0)) })) : [],
    callout: String(slide.callout || '').slice(0, 180),
    speakerNote: String(slide.speakerNote || '').slice(0, 220)
  }));
  if (!normalizedSlides.length) {
    normalizedSlides.push({ kicker: artifactType.name, title: String(prompt || 'Generated presentation').slice(0, 96), subtitle: artifactType.focus, layout: 'hero', bullets: ['A focused narrative generated from the user prompt.', 'A web-native artifact structure with reusable runtime controls.', 'Ready for refinement through chat edits.'], metrics: [], steps: [], chart: [], callout: 'Generated with a lightweight structured pipeline.', speakerNote: '' });
  }
  return {
    title: String(spec.title || prompt || 'Generated deck').slice(0, 100),
    subtitle: String(spec.subtitle || artifactType.focus || '').slice(0, 220),
    slides: normalizedSlides
  };
}

function extractHtml(raw) {
  let html = String(raw || '').trim();
  const fenced = html.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced) html = fenced[1].trim();
  const start = html.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) html = html.slice(start);
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) throw new Error('Generated output was not a complete HTML document.');
  if (!/deck-stage/i.test(html) || !/class=["'][^"']*\bslide\b/i.test(html)) throw new Error('Generated HTML is missing the fixed-stage slide structure.');
  return html;
}

function parseJsonObject(raw) {
  let text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('AI did not return JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

async function seedDemoData(env) {
  const db = await readDb(env);
  const demoEmail = String(env.DEMO_EMAIL || 'demo@slidestudio.local').trim().toLowerCase();
  if (db.users.some((user) => user.email === demoEmail)) return;
  const now = new Date().toISOString();
  const demoUser = {
    id: 'demo-user',
    name: 'Demo User',
    email: demoEmail,
    passwordHash: await hashPassword(String(env.DEMO_PASSWORD || 'demo1234')),
    createdAt: now,
    emailVerifiedAt: now,
    credits: 999,
    plan: 'paid',
    isGuest: false
  };
  const demoDeck = {
    id: 'demo-cloudflare-deck',
    userId: demoUser.id,
    prompt: 'Create a product launch deck for Slide Studio on Cloudflare.',
    templateId: 'soft-editorial',
    templateSlug: 'soft-editorial',
    title: 'Cloudflare Demo Deck',
    deckPath: '/generated/demo-cloudflare-deck.html',
    r2Key: deckKey(demoUser.id, 'demo-cloudflare-deck'),
    status: 'complete',
    currentPage: 1,
    targetContext: '',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    error: '',
    comments: [],
    versions: [],
    messages: [{ id: randomId(), role: 'assistant', text: 'Demo deck seeded for Cloudflare.', createdAt: now }]
  };
  const html = renderDeckHtmlFromSpec(normalizeDeckSpec({
    title: 'Slide Studio on Cloudflare',
    slides: [
      { kicker: 'Migration', title: 'A serverless Slide Studio', subtitle: 'D1 keeps app metadata. R2 keeps generated HTML decks.', layout: 'hero', bullets: ['No persistent server disk', 'Works on Cloudflare free building blocks', 'Railway deployment can remain as fallback'], callout: 'This demo is generated locally by the Worker seed.' },
      { kicker: 'Storage', title: 'Two durable layers', subtitle: 'Metadata and files move to managed Cloudflare services.', layout: 'metrics', metrics: [{ label: 'D1', value: 'state', note: 'users, sessions, decks, logs' }, { label: 'R2', value: 'HTML', note: 'generated artifacts and versions' }] },
      { kicker: 'Workflow', title: 'Generation flow', subtitle: 'The Worker calls an OpenAI-compatible API and writes the resulting deck to R2.', layout: 'workflow', steps: [{ label: '1', title: 'Prompt', detail: 'User selects a template and artifact type.' }, { label: '2', title: 'Model', detail: 'The Worker requests a structured deck spec.' }, { label: '3', title: 'R2', detail: 'Rendered HTML is stored as an object.' }] }
    ]
  }, 'Cloudflare demo', artifactTypes[0]), templates[1]);
  await env.DECKS.put(demoDeck.r2Key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  db.users.push(demoUser);
  db.decks.unshift(demoDeck);
  await writeDb(env, db);
}

async function createGuestUserAndSession(request, db, headers) {
  let trialId = getTrialCookie(request);
  if (!trialId) {
    trialId = randomToken(18);
    headers.append('Set-Cookie', trialCookie(trialId));
  }
  const email = `guest-${await hashIdentity(trialId)}@guest.slidestudio.local`;
  let guest = db.users.find((user) => user.email === email);
  if (!guest) {
    guest = {
      id: `guest-${randomId()}`,
      name: 'Guest',
      email,
      passwordHash: await hashPassword(randomToken()),
      createdAt: new Date().toISOString(),
      emailVerifiedAt: '',
      credits: 0,
      plan: 'trial',
      isGuest: true
    };
    db.users.push(guest);
  }
  const sessionToken = randomToken();
  db.sessions[sessionToken] = { userId: guest.id, createdAt: new Date().toISOString() };
  headers.append('Set-Cookie', sessionCookie(sessionToken));
  return guest;
}

function ensureGenerationAllowance({ request, env, db, user, template, responseHeaders }) {
  const spend = freeSpendToday(db);
  if (spend + numberEnv(env, 'GENERATION_COST_CENTS', 25) > numberEnv(env, 'FREE_DAILY_BUDGET_CENTS', 500)) {
    return { error: '今日免费额度已用完，请稍后再试或升级付费额度。', status: 429 };
  }
  const now = new Date().toISOString();
  if (!user || user.isGuest) {
    if (!basicTrialTemplateIds(env).has(template.id)) return { error: '未登录试用只能使用基础模板。注册并验证邮箱后可使用更多模板。', status: 403 };
    let trialId = getTrialCookie(request);
    if (!trialId) {
      trialId = randomToken(18);
      responseHeaders.append('Set-Cookie', trialCookie(trialId));
    }
    const browser = browserFingerprint(request);
    const device = getDeviceFingerprint(request);
    const identities = [
      ['cookie', trialId, numberEnv(env, 'GUEST_COOKIE_DAILY_LIMIT', 3)],
      ['device', device, numberEnv(env, 'GUEST_DEVICE_DAILY_LIMIT', 3)],
      ['browser', browser, numberEnv(env, 'GUEST_BROWSER_DAILY_LIMIT', 3)],
      ['ip', getClientIp(request), numberEnv(env, 'GUEST_IP_DAILY_LIMIT', 5)]
    ];
    const exceeded = identities.find(([type, key, limit]) => countUsageToday(db, (entry) => entry.identityType === type && entry.identityKey === key) >= limit);
    if (exceeded) return { error: '免费试用额度已用完。注册并验证邮箱后可获得正式额度。', status: 429 };
    return {
      spend: () => {
        for (const [type, key] of identities) {
          db.usageEvents.unshift({ id: randomId(), userId: user?.id || '', identityType: type, identityKey: key, action: 'generate', costCents: type === 'cookie' ? numberEnv(env, 'GENERATION_COST_CENTS', 25) : 0, createdAt: now });
        }
      }
    };
  }
  if (!user.emailVerifiedAt) {
    const used = countUsageToday(db, (entry) => entry.identityType === 'user' && entry.identityKey === user.id);
    if (used >= numberEnv(env, 'UNVERIFIED_USER_DAILY_LIMIT', 0)) return { error: '请先验证邮箱，验证后会发放正式免费额度。', status: 403 };
  } else if ((user.plan || 'free') !== 'paid' && Number(user.credits || 0) <= 0) {
    return { error: '你的免费额度已用完，可以购买额度继续生成。', status: 402 };
  }
  return {
    spend: () => {
      if (user.emailVerifiedAt && (user.plan || 'free') !== 'paid') user.credits = Math.max(0, Number(user.credits || 0) - 1);
      db.usageEvents.unshift({ id: randomId(), userId: user.id, identityType: 'user', identityKey: user.id, action: 'generate', costCents: numberEnv(env, 'GENERATION_COST_CENTS', 25), createdAt: now });
    }
  };
}

async function saveDeckVersion(env, deck, html, label = 'Before edit') {
  const versionId = randomId();
  const r2Key = deckVersionKey(deck.userId, deck.id, versionId);
  await env.DECKS.put(r2Key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  deck.versions ||= [];
  deck.versions.push({ id: versionId, label, r2Key, createdAt: new Date().toISOString() });
  deck.versions = deck.versions.slice(-20);
}

async function readDeckHtml(env, deck) {
  if (!deck?.r2Key) return '';
  const object = await env.DECKS.get(deck.r2Key);
  return object ? object.text() : '';
}

function publicDeck(deck) {
  if (!deck) return null;
  const { r2Key, originalR2Key, targetContext, ...safeDeck } = deck;
  safeDeck.messages ||= [];
  safeDeck.comments ||= [];
  safeDeck.versions = (safeDeck.versions || []).map(({ r2Key: _r2Key, ...version }) => version);
  return safeDeck;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.isGuest ? '' : user.email,
    isGuest: Boolean(user.isGuest),
    emailVerified: Boolean(user.emailVerifiedAt),
    credits: Number(user.credits || 0),
    plan: user.plan || 'free'
  };
}

function getUser(request, db) {
  const token = parseCookies(request).session;
  if (!token || !db.sessions[token]) return null;
  return db.users.find((user) => user.id === db.sessions[token].userId) || null;
}

function createSignupVerification(env, db, { email, name, pendingGuestUserId = '' }) {
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 3).toISOString();
  db.signupVerificationTokens.unshift({ token, email, name, pendingGuestUserId, createdAt: now.toISOString(), expiresAt, usedAt: '' });
  return `${appBaseUrl(env)}/?signup_token=${encodeURIComponent(token)}`;
}

function createEmailVerification(env, db, user, options = {}) {
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 3).toISOString();
  db.verificationTokens.unshift({ token, userId: user.id, pendingGuestUserId: options.pendingGuestUserId || '', createdAt: now.toISOString(), expiresAt, usedAt: '' });
  return `${appBaseUrl(env)}/api/verify-email?token=${token}`;
}

function mergeGuestProjectsIntoUser(db, guestUserId, user) {
  if (!guestUserId || !user || guestUserId === user.id) return { decks: 0 };
  const guest = db.users.find((item) => item.id === guestUserId && item.isGuest);
  if (!guest) return { decks: 0 };
  let decks = 0;
  for (const deck of db.decks) {
    if (deck.userId !== guest.id) continue;
    deck.userId = user.id;
    deck.updatedAt = deck.updatedAt || new Date().toISOString();
    decks += 1;
  }
  for (const entry of db.usageEvents) {
    if (entry.userId === guest.id) entry.userId = user.id;
  }
  for (const [token, session] of Object.entries(db.sessions)) {
    if (session.userId === guest.id) delete db.sessions[token];
  }
  if (decks > 0) db.users = db.users.filter((item) => item.id !== guest.id);
  return { decks };
}

function createVerificationEmailPreview(user, verificationLink) {
  return {
    to: user.email,
    from: 'Slide Studio <verify@slidestudio.local>',
    subject: 'Verify your Slide Studio email',
    provider: 'cloudflare-preview',
    verificationLink,
    expiresIn: '3 days',
    delivered: false,
    delivery: 'local-preview'
  };
}

async function hashPassword(password) {
  const salt = randomToken(16);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return `pbkdf2:${salt}:${hex(bits)}`;
}

async function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored || '').split(':');
  if (algo !== 'pbkdf2' || !salt || !hash) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return timingSafeEqual(hex(bits), hash);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return result === 0;
}

function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  return Object.fromEntries(header.split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return [part.trim(), ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function sessionCookie(token, maxAge) {
  const parts = [`session=${encodeURIComponent(token || '')}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

function trialCookie(trialId) {
  return `trial_id=${encodeURIComponent(trialId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 90}`;
}

function getTrialCookie(request) {
  return parseCookies(request).trial_id || '';
}

function usageSummaryForUser(db, user, request) {
  if (!user || user.isGuest) {
    const trialId = getTrialCookie(request);
    return {
      tier: 'guest',
      remaining: Math.max(0, 3 - countUsageToday(db, (entry) => entry.identityType === 'cookie' && entry.identityKey === trialId)),
      dailyBudgetRemainingCents: Math.max(0, 500 - freeSpendToday(db))
    };
  }
  return {
    tier: user.emailVerifiedAt ? user.plan || 'free' : 'unverified',
    remaining: user.emailVerifiedAt ? Number(user.credits || 0) : 0,
    dailyBudgetRemainingCents: Math.max(0, 500 - freeSpendToday(db))
  };
}

function countUsageToday(db, predicate) {
  const today = new Date().toISOString().slice(0, 10);
  return db.usageEvents.filter((entry) => String(entry.createdAt || '').startsWith(today) && predicate(entry)).length;
}

function freeSpendToday(db) {
  const today = new Date().toISOString().slice(0, 10);
  return db.usageEvents
    .filter((entry) => String(entry.createdAt || '').startsWith(today) && entry.action === 'generate')
    .reduce((sum, entry) => sum + Number(entry.costCents || 0), 0);
}

function browserFingerprint(request) {
  return [
    request.headers.get('user-agent') || '',
    request.headers.get('accept-language') || '',
    request.headers.get('accept-encoding') || ''
  ].join('|');
}

function getDeviceFingerprint(request) {
  return request.headers.get('x-device-id') || request.headers.get('user-agent') || 'unknown-device';
}

function getClientIp(request) {
  return request.headers.get('cf-connecting-ip') || String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

async function hashIdentity(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value || 'unknown')));
  return hex(digest).slice(0, 32);
}

function getArtifactType(id) {
  return artifactTypes.find((item) => item.id === id) || artifactTypes[0];
}

function parseTargetContext(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch (_error) {
    return {};
  }
}

function getServerModelConfig(env) {
  return {
    provider: env.OPENAI_PROVIDER || env.AI_PROVIDER || 'OpenAI',
    model: env.OPENAI_MODEL || env.AI_MODEL || 'gpt-4.1',
    baseUrl: normalizeBaseUrl(env.OPENAI_BASE_URL || env.AI_BASE_URL || 'https://api.openai.com/v1'),
    apiKey: String(env.OPENAI_API_KEY || env.AI_API_KEY || '').trim()
  };
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  return trimmed || 'https://api.openai.com/v1';
}

function themeForTemplate(template) {
  const themes = {
    'sakura-chroma': { bg: '#140f16', surface: '#fff7fb', ink: '#211821', muted: '#775f6e', accent: '#e54489', accent2: '#29b6c8', accent3: '#f3c744' },
    'soft-editorial': { bg: '#f6f1e8', surface: '#fffdf8', ink: '#25231f', muted: '#69645a', accent: '#17614f', accent2: '#d7de62', accent3: '#d97045' },
    'blue-professional': { bg: '#eef5fa', surface: '#ffffff', ink: '#18283a', muted: '#66798b', accent: '#2d75ad', accent2: '#55b8a6', accent3: '#f0b84d' },
    'creative-mode': { bg: '#fff7ed', surface: '#ffffff', ink: '#2a2118', muted: '#705f4f', accent: '#f09131', accent2: '#6d56d8', accent3: '#1aa37a' },
    'long-table': { bg: '#f2f5ef', surface: '#ffffff', ink: '#1f2a20', muted: '#5e6b60', accent: '#3d9f47', accent2: '#315f9f', accent3: '#c98d25' }
  };
  return themes[template.id] || themes[template.slug] || themes['soft-editorial'];
}

function basicTrialTemplateIds(env) {
  return new Set(String(env.BASIC_TRIAL_TEMPLATE_IDS || 'soft-editorial,blue-professional').split(',').map((item) => item.trim()).filter(Boolean));
}

function numberEnv(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function appBaseUrl(env) {
  return String(env.APP_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
}

function deckKey(userId, deckId) {
  return `decks/${userId}/${deckId}.html`;
}

function deckOriginalKey(userId, deckId) {
  return `decks/${userId}/${deckId}.original.html`;
}

function deckVersionKey(userId, deckId, versionId) {
  return `versions/${userId}/${deckId}/${versionId}.html`;
}

function progressMessage(title, detail = '', status = 'done') {
  return { id: randomId(), role: 'progress', text: JSON.stringify({ title, detail, status }), createdAt: new Date().toISOString() };
}

function randomId() {
  return crypto.randomUUID();
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sanitizeFileName(name, fallback = 'slide-deck') {
  return String(name || fallback).trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 80) || fallback;
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function json(payload, status = 200, headers = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

function htmlResponse(body, status = 200) {
  const isDocument = /<\/?[a-z][\s\S]*>/i.test(body);
  return new Response(isDocument ? body : escapeHtml(body), {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
