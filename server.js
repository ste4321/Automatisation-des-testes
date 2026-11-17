const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizeDomain(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function addProtocolIfMissing(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

async function fetchWithRetry(url, method = 'head') {
  const attempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await axios({
        method,
        url,
        timeout: 20000,
        validateStatus: () => true,
        maxRedirects: 7,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9'
        }
      });

      return {
        ok: true,
        status: response.status,
        finalUrl: response.request && response.request.res && response.request.res.responseUrl
          ? response.request.res.responseUrl
          : url,
        response: response
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  return {
    ok: false,
    status: null,
    finalUrl: url,
    error: lastError
  };
}

async function testDomain(url) {
  const startedAt = Date.now();
  const cleanedUrl = addProtocolIfMissing(normalizeDomain(url));
  if (!cleanedUrl) {
    return {
      domain: url,
      accessible: false,
      statusCode: null,
      finalUrl: url,
      responseTimeMs: 0,
      error: 'URL invalide'
    };
  }

  const headResult = await fetchWithRetry(cleanedUrl, 'head');

  if (headResult.ok) {
    return {
      domain: cleanedUrl,
      accessible: true,
      statusCode: headResult.status,
      finalUrl: headResult.finalUrl,
      responseTimeMs: Date.now() - startedAt,
      error: null
    };
  }

  const getResult = await fetchWithRetry(cleanedUrl, 'get');

  if (getResult.ok) {
    return {
      domain: cleanedUrl,
      accessible: true,
      statusCode: getResult.status,
      finalUrl: getResult.finalUrl,
      responseTimeMs: Date.now() - startedAt,
      error: null
    };
  }

  const err = getResult.error || headResult.error;
  return {
    domain: cleanedUrl,
    accessible: false,
    statusCode: null,
    finalUrl: cleanedUrl,
    responseTimeMs: Date.now() - startedAt,
    error: err && err.code === 'ECONNABORTED'
      ? 'Timeout'
      : (err && err.code === 'ENOTFOUND' ? 'DNS introuvable' : (err && err.message ? err.message : 'Inaccessible'))
  };
}

async function runChecks(items) {
  const CONCURRENCY = 5;
  const results = [];

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const chunk = items.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (item) => {
        const originalDomain = typeof item === 'string' ? item : (item && item.domain);
        const domain = addProtocolIfMissing(normalizeDomain(originalDomain));

        if (!domain) {
          return null;
        }

        const check = await testDomain(domain);

        return {
          ...(typeof item === 'object' && item ? item : {}),
          domain: check.domain,
          accessible: check.accessible,
          statusCode: check.statusCode,
          finalUrl: check.finalUrl,
          responseTimeMs: check.responseTimeMs,
          error: check.error
        };
      })
    );

    results.push(...chunkResults.filter(Boolean));
  }

  return results;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'API ready' });
});

app.post('/api/check-domains', async (req, res) => {
  try {
    const payload = req.body;
    const items = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.domains) ? payload.domains : []);

    if (!items.length) {
      return res.status(400).json({
        error: 'Aucune donnée fournie. Envoyez un tableau JSON de domaines.'
      });
    }

    const normalizedItems = items.filter(item => {
      if (typeof item === 'string') return addProtocolIfMissing(normalizeDomain(item));
      return item && typeof item.domain === 'string' && addProtocolIfMissing(normalizeDomain(item.domain));
    });

    if (!normalizedItems.length) {
      return res.status(400).json({
        error: 'Aucun domaine valide détecté dans la liste fournie.'
      });
    }

    const results = await runChecks(normalizedItems);

    const accessible = results.filter(item => item.accessible);
    const inaccessible = results.filter(item => !item.accessible);

    const report = {
      summary: {
        total: results.length,
        accessible: accessible.length,
        inaccessible: inaccessible.length
      },
      accessible,
      inaccessible,
      generatedAt: new Date().toISOString()
    };

    res.json(report);
  } catch (error) {
    res.status(500).json({
      error: 'Erreur pendant le test des domaines',
      details: error.message
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`Application lancée sur http://localhost:${port}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.log(`Port ${port} occupé, tentative sur ${port + 1}`);
      startServer(port + 1);
      return;
    }

    throw error;
  });
}

startServer(PORT);
