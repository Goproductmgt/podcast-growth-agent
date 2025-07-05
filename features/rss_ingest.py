import os
import requests
import feedparser
from openai import OpenAI
from dotenv import load_dotenv
from pathlib import Path

# === ENV SETUP ===
env_path = Path(__file__).resolve().parent / '.env'
load_dotenv(env_path)
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# === RSS RESOLVER ===
def resolve_feed_url(user_input):
    if "podcasts.apple.com" in user_input:
        import re
        match = re.search(r'id(\d+)', user_input)
        if match:
            podcast_id = match.group(1)
            return f"https://podcasts.apple.com/rss/podcast/{podcast_id}.xml"
        else:
            print("⚠️ Could not extract Apple podcast ID.")
            return None
    elif user_input.endswith('.xml') or "rss" in user_input:
        return user_input
    else:
        print("⚠️ Unsupported URL format.")
        return None

# === WHISPER TRANSCRIPTION ===
def transcribe_audio(file_path):
    with open(file_path, "rb") as audio_file:
        transcript = client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            response_format="text"
        )
    return transcript

# === EPISODE DOWNLOADER ===
def download_episodes_from_rss(rss_url, limit=3):
    feed = feedparser.parse(rss_url)
    episodes = feed.entries[:limit]
    downloads_dir = "downloads"
    os.makedirs(downloads_dir, exist_ok=True)

    for entry in episodes:
        title = entry.title.replace(" ", "_").replace("/", "-")
        audio_url = entry.enclosures[0].href if entry.enclosures else None

        transcript_text = entry.get("content", [{}])[0].get("value", "") or entry.get("summary", "")
        transcript_path = os.path.join(downloads_dir, f"{title}_transcript.txt")

        if transcript_text:
            with open(transcript_path, "w", encoding="utf-8") as tf:
                tf.write(transcript_text)
            print(f"📝 Transcript scraped and saved to {transcript_path}")
            continue  # Skip Whisper if transcript exists

        if audio_url:
            audio_path = os.path.join(downloads_dir, f"{title}.mp3")
            print(f"🎧 Downloading audio: {title}")
            response = requests.get(audio_url)
            with open(audio_path, "wb") as f:
                f.write(response.content)
            print(f"✅ Saved to {audio_path}")

            try:
                whisper_transcript = transcribe_audio(audio_path)
                with open(transcript_path, "w", encoding="utf-8") as tf:
                    tf.write(whisper_transcript)
                print(f"📝 Whisper transcript saved to {transcript_path}")
            except Exception as e:
                print(f"⚠️ Whisper error for {title}: {e}")
        else:
            print(f"❌ No audio file found for: {title}")

# === MAIN RUN ===
if __name__ == "__main__":
    user_input = input("Paste podcast URL or RSS feed: ")
    rss_feed = resolve_feed_url(user_input)

    if rss_feed:
        download_episodes_from_rss(rss_feed)
    else:
        print("❌ Could not resolve to a valid RSS feed.")


