const client = require('openid-client');
const { Strategy } = require('openid-client/passport');
const passport = require('passport');
const session = require('express-session');
const connectPg = require('connect-pg-simple');
const memoize = require('memoizee');
const { pool } = require('./db');

const getOidcConfig = memoize(
  async () => {
    return await client.discovery(
      new URL(process.env.ISSUER_URL || 'https://replit.com/oidc'),
      process.env.REPL_ID
    );
  },
  { maxAge: 3600 * 1000 }
);

function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000;
  const PgStore = connectPg(session);
  const sessionStore = new PgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: 'sessions',
  });
  return session({
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      maxAge: sessionTtl,
    },
  });
}

function updateUserSession(user, tokens) {
  user.claims = tokens.claims();
  user.access_token = tokens.access_token;
  user.refresh_token = tokens.refresh_token;
  user.expires_at = user.claims?.exp;
}

async function upsertUser(claims) {
  await pool.query(
    `INSERT INTO users (id, email, first_name, last_name, profile_image_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       profile_image_url = EXCLUDED.profile_image_url,
       updated_at = NOW()
     RETURNING *`,
    [claims.sub, claims.email, claims.first_name, claims.last_name, claims.profile_image_url]
  );
}

async function setupAuth(app) {
  app.set('trust proxy', 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  const config = await getOidcConfig();
  const registeredStrategies = new Set();

  const verify = async (tokens, verified) => {
    const user = {};
    updateUserSession(user, tokens);
    await upsertUser(tokens.claims());
    verified(null, user);
  };

  const ensureStrategy = (domain) => {
    const strategyName = `replitauth:${domain}`;
    if (!registeredStrategies.has(strategyName)) {
      const strategy = new Strategy(
        {
          name: strategyName,
          config,
          scope: 'openid email profile offline_access',
          callbackURL: `https://${domain}/api/callback`,
        },
        verify
      );
      passport.use(strategy);
      registeredStrategies.add(strategyName);
    }
  };

  passport.serializeUser((user, cb) => cb(null, user));
  passport.deserializeUser((user, cb) => cb(null, user));

  app.get('/api/login', (req, res, next) => {
    ensureStrategy(req.hostname);
    passport.authenticate(`replitauth:${req.hostname}`, {
      prompt: 'login consent',
      scope: ['openid', 'email', 'profile', 'offline_access'],
    })(req, res, next);
  });

  app.get('/api/callback', (req, res, next) => {
    ensureStrategy(req.hostname);
    passport.authenticate(`replitauth:${req.hostname}`, {
      successReturnToOrRedirect: '/',
      failureRedirect: '/api/login',
    })(req, res, next);
  });

  app.get('/api/logout', (req, res) => {
    req.logout(() => {
      res.redirect(
        client.buildEndSessionUrl(config, {
          client_id: process.env.REPL_ID,
          post_logout_redirect_uri: `${req.protocol}://${req.hostname}`,
        }).href
      );
    });
  });

  app.get('/api/auth/user', isAuthenticated, async (req, res) => {
    try {
      const userId = req.user.claims.sub;
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      res.json(rows[0] || null);
    } catch (error) {
      console.error('Error fetching user:', error);
      res.status(500).json({ message: 'Failed to fetch user' });
    }
  });
}

async function isAuthenticated(req, res, next) {
  const user = req.user;

  if (!req.isAuthenticated() || !user?.expires_at) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now <= user.expires_at) {
    return next();
  }

  const refreshToken = user.refresh_token;
  if (!refreshToken) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const config = await getOidcConfig();
    const tokenResponse = await client.refreshTokenGrant(config, refreshToken);
    updateUserSession(user, tokenResponse);
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
}

module.exports = { setupAuth, isAuthenticated };
