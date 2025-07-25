import { useState } from 'react';
import { upload } from '@vercel/blob/client';

export default function UploadPage() {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleFileSelect = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError(null);
      setResult(null);
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    setProgress(0);
    setError(null);

    try {
      console.log('📁 Uploading to Vercel Blob...');
      setProgress(25);
      
      const blob = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/blob-upload',
      });

      console.log('✅ File uploaded to Blob:', blob.url);
      setProgress(50);

      console.log('🧠 Starting analysis...');
      const analysisResponse = await fetch('/api/analyze-from-blob', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          blobUrl: blob.url,
          filename: file.name,
          title: document.getElementById('episodeTitle')?.value || file.name,
        }),
      });

      if (!analysisResponse.ok) {
        throw new Error(`Analysis failed: ${analysisResponse.statusText}`);
      }

      setProgress(75);

      const reader = analysisResponse.body.getReader();
      const decoder = new TextDecoder();
      let analysisResult = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        analysisResult += chunk;
        
        const lines = analysisResult.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.status === 'success') {
                setResult(parsed);
                setProgress(100);
              } else if (parsed.progress) {
                setProgress(Math.max(75, parsed.progress));
              }
            } catch (e) {
              // Continue if line isn't valid JSON
            }
          }
        }
      }

    } catch (err) {
      console.error('Upload/Analysis error:', err);
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto', padding: '20px' }}>
      <h1>🎙️ Podcast Growth Agent</h1>
      <p>Upload your podcast episode for AI-powered growth analysis</p>
      
      <div style={{ marginBottom: '20px' }}>
        <input
          type="file"
          accept=".mp3,.m4a,.wav"
          onChange={handleFileSelect}
          style={{ marginBottom: '10px', width: '100%', padding: '10px' }}
        />
        
        <input
          type="text"
          id="episodeTitle"
          placeholder="Episode title (optional)"
          style={{ width: '100%', padding: '10px', marginBottom: '10px' }}
        />
        
        <button
          onClick={handleUpload}
          disabled={!file || uploading}
          style={{
            width: '100%',
            padding: '12px',
            backgroundColor: uploading ? '#ccc' : '#FF7F50',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: uploading ? 'not-allowed' : 'pointer',
            fontSize: '16px',
          }}
        >
          {uploading ? `Processing... ${progress}%` : '🚀 Analyze Episode'}
        </button>
      </div>

      {file && (
        <div style={{ backgroundColor: '#f0f0f0', padding: '10px', borderRadius: '6px', marginBottom: '20px' }}>
          <strong>Selected:</strong> {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
        </div>
      )}

      {progress > 0 && uploading && (
        <div style={{ marginBottom: '20px' }}>
          <div style={{ backgroundColor: '#e0e0e0', height: '8px', borderRadius: '4px' }}>
            <div
              style={{
                backgroundColor: '#FF7F50',
                height: '100%',
                width: `${progress}%`,
                borderRadius: '4px',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
          <p style={{ textAlign: 'center', marginTop: '5px' }}>{progress}% Complete</p>
        </div>
      )}

      {error && (
        <div style={{ backgroundColor: '#ffebee', padding: '15px', borderRadius: '6px', border: '1px solid #f44336', marginBottom: '20px' }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div style={{ backgroundColor: '#e8f5e8', padding: '20px', borderRadius: '6px', border: '1px solid #4caf50' }}>
          <h3>✅ Analysis Complete!</h3>
          <div style={{ marginTop: '15px' }}>
            <h4>Episode Summary:</h4>
            <p>{result.analysis?.episode_summary}</p>
            
            <h4>Optimized Title:</h4>
            <p><strong>{result.analysis?.optimized_title}</strong></p>
            
            <h4>Tweetable Quotes:</h4>
            <ul>
              {result.analysis?.tweetable_quotes?.map((quote, i) => (
                <li key={i}>{quote}</li>
              ))}
            </ul>
            
            <h4>Processing Info:</h4>
            <p>Duration: {result.metadata?.audio_metrics?.durationMinutes} minutes</p>
            <p>Processing time: {(result.metadata?.processing_time_ms / 1000).toFixed(1)}s</p>
          </div>
        </div>
      )}
    </div>
  );
}