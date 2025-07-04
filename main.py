import os
from dotenv import load_dotenv
from openai import OpenAI
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from pathlib import Path
import os

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

spotify = spotipy.Spotify(auth_manager=sp_oauth)
# Example: Redesigning Health & Home podcast
show_id = "41UJ6L0AksZCXNv00jA1jk"

episodes = spotify.show_episodes(show_id, limit=5)

for ep in episodes['items']:
    print("\n🎧 Episode Info:")
    print("Title:", ep['name'])
    print("Description:", ep['description'])
    print("Audio Preview URL:", ep['audio_preview_url'])
    print("Episode ID:", ep['id'])

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
