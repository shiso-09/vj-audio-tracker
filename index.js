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

app.post('/api/identify', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '音声データがありません' });
    }

    // 1. ACRCloudで楽曲認識
    const result = await acr.identify(req.file.buffer);
    const metadata = typeof result === 'string' ? JSON.parse(result) : result;

    if (
      !metadata.status ||
      metadata.status.code !== 0 ||
      !metadata.metadata ||
      !metadata.metadata.music ||
      metadata.metadata.music.length === 0
    ) {
      return res.json({ success: false, message: '楽曲を識別できませんでした。' });
    }

    const track = metadata.metadata.music[0];
    const title = track.title;
    const artist = track.artists ? track.artists[0].name : 'Unknown';
    const playOffset = (track.play_offset_ms || 0) / 1000;

    // 2. Spotify API (BPM, Audio Analysis, アートワーク画像)
    let apiBpm = null;
    let energySegments = [];
    let trackDuration = 0;
    let albumArtUrl = null;

    try {
      const spotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      });
      const tokenData = await spotifyApi.clientCredentialsGrant();
      spotifyApi.setAccessToken(tokenData.body['access_token']);

      const spotifySearch = await spotifyApi.searchTracks(`track:${title} artist:${artist}`);
      if (spotifySearch.body.tracks && spotifySearch.body.tracks.items.length > 0) {
        const trackObj = spotifySearch.body.tracks.items[0];
        const trackId = trackObj.id;
        trackDuration = trackObj.duration_ms / 1000;

        // アートワーク画像URLを取得
        if (trackObj.album && trackObj.album.images && trackObj.album.images.length > 0) {
          albumArtUrl = trackObj.album.images[0].url;
        }

        // BPM取得
        const audioFeatures = await spotifyApi.getAudioFeaturesForTrack(trackId);
        if (audioFeatures.body && audioFeatures.body.tempo) {
          apiBpm = Math.round(audioFeatures.body.tempo);
        }

        // オーディオ分析（構造）取得
        const audioAnalysis = await spotifyApi.getAudioAnalysisForTrack(trackId);
        if (audioAnalysis.body && audioAnalysis.body.segments) {
          energySegments = audioAnalysis.body.segments.map(s => ({
            start: s.start,
            duration: s.duration,
            loudness: s.loudness_max
          }));
        }
      }
    } catch (err) {
      console.log('Spotify lookup fallback:', err);
    }

    // 3. 歌詞の自動取得
    let lyrics = '歌詞が見つかりませんでした。';
    try {
      const lyricRes = await fetch(`https://lyrist.vercel.app/api/${encodeURIComponent(title)}/${encodeURIComponent(artist)}`);
      if (lyricRes.ok) {
        const lyricData = await lyricRes.json();
        if (lyricData && lyricData.lyrics) {
          lyrics = lyricData.lyrics;
        }
      }
    } catch (e) {
      console.log('Lyrics fetch failed:', e);
    }

    res.json({
      success: true,
      title: title,
      artist: artist,
      apiBpm: apiBpm,
      lyrics: lyrics,
      playOffset: playOffset,
      trackDuration: trackDuration,
      segments: energySegments,
      albumArtUrl: albumArtUrl
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'サーバー内でエラーが発生しました。' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
