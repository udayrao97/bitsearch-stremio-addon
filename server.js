// A Stremio addon server that scrapes Bitsearch and integrates with Real-Debrid.
// This version includes a dedicated settings page and dynamic manifest generation.
// The addon settings are now encoded to prevent URL length errors.

// Prerequisites:
// 1. Install Node.js and npm.
// 2. Run `npm init -y` in your project folder.
// 3. Run `npm install express axios cheerio` to install dependencies.
// 4. Save both `server.js` and `index.html` in the same folder.
// 5. Run `node server.js`.

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// =================================================================================================
// STREMIO ADDON MANIFEST
// The manifest describes what your addon does and its configurable options.
// =================================================================================================

// This is a dynamic manifest function now.
// It generates the manifest based on the query parameters from the config page.
// The main manifest is static, and the config is handled by the URL on install.
const baseManifest = {
    id: 'com.yourname.bitsearchrd',
    version: '1.6.0', // Updated version to reflect the fix
    name: 'Bitsearch Real-Debrid Addon',
    description: 'Scrapes Bitsearch and checks for cached torrents on Real-Debrid. Now with a dedicated settings page!',
    behaviorHints: {
        configurable: true,
        // configurationRequired is not needed, we'll redirect to a configuration page instead.
    },
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
};

// CORS middleware to allow Stremio to access the server.
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Serve the static configuration page.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// =================================================================================================
// ENDPOINTS
// This is where Stremio will make its requests.
// =================================================================================================

// New root endpoint for health checks.
app.get('/', (req, res) => {
    res.send('This is a Stremio addon for Bitsearch and Real-Debrid. Go to /configure to set it up.');
});

// Manifest Endpoint - this is a static manifest for the initial install.
app.get('/manifest.json', (req, res) => {
    res.json(baseManifest);
});

// This new endpoint handles the installation of the configured addon.
app.get('/manifest/:config.json', (req, res) => {
    const { config } = req.params;
    const manifest = {
        ...baseManifest,
        // This is the new, working installation URL
        configurable: `/configure?config=${config}`
    };
    res.json(manifest);
});

// Stream Endpoint
app.get('/stream/:type/:id/:config.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        const encodedConfig = req.params.config;

        if (!encodedConfig) {
            return res.json({ streams: [], error: 'Configuration not provided.' });
        }

        // Decode the configuration from the URL.
        const config = JSON.parse(Buffer.from(encodedConfig, 'base64').toString('utf-8'));
        const { realdebridKey, quality, codec, audio, fallback, exclude } = config;

        if (!realdebridKey) {
            return res.json({ streams: [], error: 'Real-Debrid API key not provided in settings.' });
        }

        const [imdbId, season, episode] = id.split(':');
        console.log(`Received request for IMDb ID: ${imdbId}`);

        let searchQuery = '';
        if (type === 'movie') {
            const movieTitle = await getTitleFromImdbId(imdbId);
            searchQuery = movieTitle;
        } else if (type === 'series' && season && episode) {
            const seriesTitle = await getTitleFromImdbId(imdbId);
            searchQuery = `${seriesTitle} S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;
        } else {
            return res.json({ streams: [] });
        }

        // Scrape Bitsearch for magnets, applying quality and sorting filters.
        const magnets = await scrapeBitsearch(searchQuery, quality, codec, audio, exclude);

        if (magnets.length === 0) {
            console.log('No magnets found on Bitsearch.');
            return res.json({ streams: [] });
        }

        console.log(`Found ${magnets.length} magnets, checking Real-Debrid cache...`);

        // Check cache on Real-Debrid for each magnet.
        const streams = await checkRealDebridCache(magnets, realdebridKey);

        if (streams.length > 0) {
            console.log(`Found ${streams.length} cached streams on Real-Debrid.`);
            return res.json({ streams: streams });
        }

        // Fallback logic: If no cached streams are found and fallback is enabled.
        if (fallback === 'true' || fallback === true) {
            console.log('No cached streams found. Checking for non-cached torrents to add.');
            const fallbackStream = await addNonCachedTorrentToRealDebrid(magnets, realdebridKey);
            if (fallbackStream) {
                console.log('Successfully added a non-cached torrent to Real-Debrid.');
                return res.json({ streams: [fallbackStream] });
            }
        }

        console.log('No streams available.');
        res.json({ streams: [] });

    } catch (error) {
        console.error('Error in stream handler:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// =================================================================================================
// HELPER FUNCTIONS
// These functions perform the scraping and API calls.
// =================================================================================================

// Function to get movie/series title from IMDb ID.
// This is a crucial step to get the correct search query for torrent sites.
async function getTitleFromImdbId(imdbId) {
    try {
        const url = `https://v3-cinemeta.strem.io/meta/tt/${imdbId}.json`;
        const response = await axios.get(url);
        if (response.data && response.data.meta && response.data.meta.name) {
            return response.data.meta.name;
        }
        return '';
    } catch (error) {
        console.error(`Error fetching title for IMDb ID ${imdbId}: ${error.message}`);
        return '';
    }
}

// Scrape Bitsearch for magnet links, with quality and filter options.
async function scrapeBitsearch(query, preferredQuality, preferredCodec, preferredAudio, excludeKeywords) {
    const magnets = [];
    // Bitsearch sorting: `sort=seeders` gives the most popular torrents first.
    const searchUrl = `https://bitsearch.to/search?q=${encodeURIComponent(query)}&sort=seeders`;
    
    console.log(`Scraping Bitsearch with query: ${query}, sorted by seeders.`);

    try {
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const $ = cheerio.load(response.data);
        const qualityList = preferredQuality ? preferredQuality.split(',').map(q => q.toLowerCase().trim()) : [];
        const codecList = preferredCodec ? preferredCodec.split(',').map(c => c.toLowerCase().trim()) : [];
        const audioList = preferredAudio ? preferredAudio.split(',').map(a => a.toLowerCase().trim()) : [];
        const excludeList = excludeKeywords ? excludeKeywords.split(',').map(k => k.toLowerCase().trim()) : [];
        
        $('table.table tbody tr').each((index, element) => {
            const title = $(element).find('td a').first().text().trim();
            const magnetLink = $(element).find('a[href^="magnet:"]').attr('href');
            
            if (magnetLink) {
                const titleLower = title.toLowerCase();
                
                // Apply all filters.
                const matchesQuality = qualityList.length === 0 || qualityList.some(q => titleLower.includes(q));
                const matchesCodec = codecList.length === 0 || codecList.some(c => titleLower.includes(c));
                const matchesAudio = audioList.length === 0 || audioList.some(a => titleLower.includes(a));
                const matchesExclude = excludeList.some(k => titleLower.includes(k));

                if (matchesQuality && matchesCodec && matchesAudio && !matchesExclude) {
                    magnets.push({ title, magnet: magnetLink });
                }
            }
        });

    } catch (error) {
        console.error('Error scraping Bitsearch:', error.message);
    }
    
    return magnets;
}


// Check a list of magnets on Real-Debrid's cache.
async function checkRealDebridCache(magnets, realdebridKey) {
    const streams = [];
    const url = 'https://api.real-debrid.com/rest/1.0/torrents/instantAvailability';

    const hashes = magnets.map(magnet => {
        const hash = magnet.magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/);
        return hash ? hash[1] : null;
    }).filter(hash => hash);

    if (hashes.length === 0) {
        console.log('No valid hashes found from magnets.');
        return [];
    }
    
    try {
        const response = await axios.get(url, {
            params: { 'hashes': hashes.join('/') },
            headers: { Authorization: `Bearer ${realdebridKey}` }
        });

        const data = response.data;
        
        for (const hash in data) {
            // Check for cached files on Real-Debrid.
            if (data[hash].rd && data[hash].rd.length > 0) {
                // To get the streamable link, we need to `unrestrict` it.
                // The cache check returns a `link`, but it's not a direct streaming link.
                const unrestrictUrl = 'https://api.real-debrid.com/rest/1.0/unrestrict/link';
                const directLink = await axios.post(unrestrictUrl, {
                    link: data[hash].rd[0].link,
                }, {
                    headers: { Authorization: `Bearer ${realdebridKey}` }
                });

                const magnet = magnets.find(m => m.magnet.includes(hash));
                if (magnet) {
                    streams.push({
                        title: `RD Cached: ${magnet.title}`,
                        url: directLink.data.download
                    });
                }
            }
        }
    } catch (error) {
        console.error('Error checking Real-Debrid cache:', error.message);
    }

    return streams;
}

// Add a non-cached torrent to Real-Debrid.
async function addNonCachedTorrentToRealDebrid(magnets, realdebridKey) {
    // This function will find the best torrent (highest seeds) and add it to RD.
    const torrentToAdd = magnets[0];
    if (!torrentToAdd) return null;

    try {
        console.log(`Adding magnet to Real-Debrid: ${torrentToAdd.title}`);
        const addMagnetUrl = 'https://api.real-debrid.com/rest/1.0/torrents/addMagnet';
        const addMagnetResponse = await axios.post(addMagnetUrl, {
            magnet: torrentToAdd.magnet,
        }, {
            headers: { Authorization: `Bearer ${realdebridKey}` }
        });

        const torrentId = addMagnetResponse.data.id;
        if (!torrentId) {
            console.error('Failed to get torrent ID from Real-Debrida.');
            return null;
        }

        // Select the files of the torrent. For simplicity, we select all files.
        const selectFilesUrl = `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`;
        await axios.post(selectFilesUrl, {
            files: 'all',
        }, {
            headers: { Authorization: `Bearer ${realdebridKey}` }
        });

        // Return a stream that tells Stremio the torrent is being downloaded.
        return {
            title: `[RD - Downloading]: ${torrentToAdd.title}`,
            url: `magnet:?xt=urn:btih:${torrentId}` // Use a magnet link to indicate downloading state.
        };

    } catch (error) {
        console.error('Error adding torrent to Real-Debrid:', error.message);
        return null;
    }
}

// Start the server.
app.listen(PORT, () => {
    console.log(`Stremio addon server is running on http://localhost:${PORT}`);
    console.log(`Install URL: http://localhost:${PORT}/manifest.json`);
});
