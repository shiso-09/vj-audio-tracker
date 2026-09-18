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
    let trackDuration = 180;
    let albumArtUrl = null;
    let spotifyError = false;

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

        if (trackObj.album && trackObj.album.images && trackObj.album.images.length > 0) {
          albumArtUrl = trackObj.album.images[0].url;
        }

        const audioFeatures = await spotifyApi.getAudioFeaturesForTrack(trackId);
        if (audioFeatures.body && audioFeatures.body.tempo) {
          apiBpm = Math.round(audioFeatures.body.tempo);
        }

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
      console.error('Spotify API Error:', err.message);
      spotifyError = true;
    }

    // 3. 歌詞取得 (LRCLIB API)
    let lyrics = '歌詞が見つかりませんでした。';
    try {
      const lrcGetUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
      let lrcRes = await fetch(lrcGetUrl);
      
      if (!lrcRes.ok) {
        // バックアップ検索
        const lrcSearchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(title + ' ' + artist)}`;
        lrcRes = await fetch(lrcSearchUrl);
        if (lrcRes.ok) {
          const searchData = await lrcRes.json();
          if (Array.isArray(searchData) && searchData.length > 0) {
            lyrics = searchData[0].plainLyrics || searchData[0].syncedLyrics || lyrics;
          }
        }
      } else {
        const lrcData = await lrcRes.json();
        lyrics = lrcData.plainLyrics || lrcData.syncedLyrics || lyrics;
      }
    } catch (e) {
      console.error('Lyrics fetch failed:', e);
    }

    // タイムスタンプ([00:12.34])のクリーンアップ処理
    if (lyrics && lyrics.includes('[')) {
      lyrics = lyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
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
      albumArtUrl: albumArtUrl,
      spotifyError: spotifyError
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
