# Video Proxy

Node server to transcode video files and stream on the fly via HLS.

#### Note: requires **[ffmpeg](http://ffmpeg.org)**

### What is the problem?

Streaming videos of any format on demand with seeking.

### How to achieve this?

Using FFmpeg and HTTP Live Streaming (HLS) protocol.

Generate the full `.m3u8` playlist immediately so the client behaves as if the entire video is ready to play. In order to make the playlist ahead of time we need to set a static segment length. When the client seeks to a portion of the video that has not been transcoded yet, we cancel the current job and start a new one.

## How it Works

1. Receive request to start stream session (i.e. `localhost:4000/stream/name-of-movie.mkv`)
2. Get metadata from video file using FFprobe
3. Use file metadata & client limitations to determine how the video will be transcoded (or if)
4. Generate `.m3u8` playlists
5. Start the FFmpeg job of remuxing video to HLS
6. Listen for `.m3u8` and `.ts` requests from client player (HLS.js)

## License

[MIT](https://choosealicense.com/licenses/mit/)
