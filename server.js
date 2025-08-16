// A Stremio addon server that scrapes Bitsearch and integrates with Real-Debrid.
// This version includes configurable settings for quality and fallback behavior.

// Prerequisites:
// 1. Install Node.js and npm.
// 2. Run `npm init -y` in your project folder.
// 3. Run `npm install express axios cheerio` to install dependencies.
// 4. Save this code as `server.js` and run it with `node server.js`.

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// You will need to obtain your Real-Debrid API key from your account settings.
// This addon works by having the user input their API key directly into the addon settings.

// =================================================================================================
// STREMIO ADDON MANIFEST
// The manifest describes what your addon does and its configurable options.
// =================================================================================================

const manifest = {
    id: 'com.yourname.bitsearchrd',
    version: '1.1.0',
    name: 'Bitsearch Real-Debrid Addon',
    description: 'Scrapes Bitsearch and checks for cached torrents on Real-Debrid. Now with more features!',
    // The "extra" field is how we get user-configurable settings.
    extra: [
        {
            name: 'realdebridKey',
            title: 'Real-Debrid API Key',
            type: 'text',
            isRequired: true,
        },
        {
            name: 'preferredQuality',
            title: 'Preferred Quality',
            type: 'select',
            options: ['4K', '1080p', '720p', 'Any'],
            optionsLabels: { '4K': '4K', '1080p': '1080p', '720p': '720p', 'Any': 'Any' },
            defaultValue: 'Any',
            isRequired: true,
        },
        {
            name: 'fallback',
            title: 'Add non-cached torrents to RD',
            type: 'checkbox',
            defaultValue: true,
        },
    ],
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: {
        configurable: true,
    },
};

// CORS middleware to allow Stremio to access the server.
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// =================================================================================================
// ENDPOINTS
// This is where Stremio will make its requests.
// =================================================================================================

app.get('/manifest.json', (req, res) => {
    res.json(manifest);
});

// Stream Endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        const { realdebridKey, preferredQuality, fallback } = req.query;

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
        const magnets = await scrapeBitsearch(searchQuery, preferredQuality);

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

// Scrape Bitsearch for magnet links, with quality filtering.
async function scrapeBitsearch(query, preferredQuality) {
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

        $('table.table tbody tr').each((index, element) => {
            const title = $(element).find('td a').first().text().trim();
            const magnetLink = $(element).find('a[href^="magnet:"]').attr('href');

            if (magnetLink) {
                magnets.push({ title, magnet: magnetLink });
            }
        });

        // Filter by preferred quality.
        if (preferredQuality !== 'Any') {
            const filteredMagnets = magnets.filter(m => m.title.includes(preferredQuality));
            if (filteredMagnets.length > 0) {
                console.log(`Filtered to ${filteredMagnets.length} results matching ${preferredQuality}.`);
                return filteredMagnets;
            }
        }
        
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
            console.error('Failed to get torrent ID from Real-Debrid.');
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


