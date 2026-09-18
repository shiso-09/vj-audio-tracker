const express = require('express');
const multer = require('multer');
const ACRcloud = require('acrcloud');
const SpotifyWebApi = require('spotify-web-api-node');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static('public'));
app.use(express.json());

const acr = new ACRcloud({
  host: process.env.ACR_HOST,
  access_key: process.env.ACR_ACCESS_KEY,
  access_secret: process.env.ACR_SECRET_KEY,
});

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

async function getSpotifyToken() {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
  } catch (err) {
    console.error('Spotify token error:', err);
  }
}

app.post('/api/identify', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '音声データがありません' });
    }

    // 1. ACRCloudで楽曲認識
    const result = await acr.identify(req.file.buffer);
    const metadata = JSON.parse(result);

    if (
      !metadata.status ||
      metadata.status.code !== 0 ||
      !metadata.metadata.music ||
      metadata.metadata.music.length === 0
    ) {
      return res.json({ success: false, message: '楽曲を識別できませんでした。' });
    }

    const track = metadata.metadata.music[0];
    const title = track.title;
    const artist = track.artists ? track.artists[0].name : 'Unknown';

    // 2. Spotify APIでBPM情報を検索
    await getSpotifyToken();
    const spotifySearch = await spotifyApi.searchTracks(`track:${title} artist:${artist}`);
    
    let bpm = '不明';

    if (spotifySearch.body.tracks.items.length > 0) {
      const trackId = spotifySearch.body.tracks.items[0].id;
      try {
        const audioFeatures = await spotifyApi.getAudioFeaturesForTrack(trackId);
        if (audioFeatures.body && audioFeatures.body.tempo) {
          bpm = Math.round(audioFeatures.body.tempo);
        }
      } catch (e) {
        console.log('BPM取得エラー:', e);
      }
    }

    res.json({
      success: true,
      title: title,
      artist: artist,
      bpm: bpm,
      searchLyricsUrl: `https://www.google.com/search?q=${encodeURIComponent(title + ' ' + artist + ' 歌詞')}`
    });

  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).json({ error: 'サーバー内でエラーが発生しました。' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
