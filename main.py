import os
from dotenv import load_dotenv
from openai import OpenAI
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from pathlib import Path
import os
from features.rss_ingest import resolve_feed_url

env_path = Path(__file__).resolve().parent / '.env'
load_dotenv(env_path)

# Load environment variables
print("✅ SPOTIFY_CLIENT_ID:", os.getenv("SPOTIFY_CLIENT_ID"))

# Access API keys
spotify_client_id = os.getenv("SPOTIFY_CLIENT_ID")
spotify_client_secret = os.getenv("SPOTIFY_CLIENT_SECRET")
spotify_redirect_uri = os.getenv("SPOTIFY_REDIRECT_URI")
sp_oauth = SpotifyOAuth(
    client_id=spotify_client_id,
    client_secret=spotify_client_secret,
    redirect_uri=spotify_redirect_uri,
    scope="user-read-playback-state"
)

from features.rss_ingest import resolve_feed_url, download_episodes_from_rss

apple_url = input("Paste Apple Podcasts URL: ")
rss_url = resolve_feed_url(apple_url)

if not rss_url:
    print("⚠️ Could not resolve RSS feed from the Apple Podcasts URL.")
    exit()

download_episodes_from_rss(rss_url, limit=3)


def transcribe_audio(file_path, client):
    with open(file_path, "rb") as audio_file:
       transcript = client.audio.transcriptions.create(
    model="whisper-1",
    file=audio_file,
    response_format="text"
)
    return transcript


api_key = os.getenv("OPENAI_API_KEY")

# === User input ===
print("🎙️ Podcast Episode Classifier")
title = input("Enter episode title: ")
summary = input("Enter a short episode summary: ")

# === Construct prompt ===
system_prompt = (
    "You are an AI assistant helping classify podcast episodes into general categories.\n"
    "Given a title and summary, output one or two high-level topic labels.\n"
    "Choose from: Health, Home, Lifestyle, Business, Culture, Education, Personal Growth, Relationships, Food, Parenting, Other."
)
user_prompt = f"Title: {title}\nSummary: {summary}\n\nWhat are the best categories for this episode?"


# === Call OpenAI using new SDK ===
client = OpenAI(api_key=api_key)
# === Test transcription ===
audio_path = "example.mp3"  # Replace with your own file if needed
try:
    transcription = transcribe_audio(audio_path, client)
    print("\n📝 Transcript:\n", transcription)
except Exception as e:
    print("⚠️ Error transcribing audio:", e)

response = client.chat.completions.create(
    model="gpt-3.5-turbo",
    messages=[
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ],
    temperature=0.5,
)

# === Output ===
topic = response.choices[0].message.content.strip()
print(f"\n🧠 Suggested Topic: {topic}")
# === Set up OpenAI Whisper client ===
from openai import OpenAI

api_key = os.getenv("OPENAI_API_KEY")
client = OpenAI(api_key=api_key)

# === Transcribe all downloaded episodes ===
from pathlib import Path

downloads_path = Path("downloads")
mp3_files = list(downloads_path.glob("*.mp3"))

for mp3_file in mp3_files:
    print(f"\n🔊 Transcribing: {mp3_file.name}")
    try:
        transcript = transcribe_audio(mp3_file, client)
        print(f"📝 Transcript for {mp3_file.name[:50]}...\n{transcript[:300]}...\n")
    except Exception as e:
        print(f"⚠️ Failed to transcribe {mp3_file.name}: {e}")
