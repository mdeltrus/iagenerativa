/* ============================================================
   RecruitAI — App Logic
   Google Generative AI (Gemini) REST API Integration
   ============================================================ */

'use strict';

// ─── State ────────────────────────────────────────────────────
let apiKey        = localStorage.getItem('recruit_ai_key') || '';
let model         = 'gemini-2.0-flash';
let chatHistory   = [];          // { role:'user'|'model', parts:[{text}] }
let sessionHistory = [];         // [{id, title, history}] for sidebar
let isLoading     = false;
let currentSessionId = null;

const SYSTEM_PROMPT = `Eres RecruitAI, un asistente experto en reclutamiento y gestión de talento humano. 
Tu especialidad incluye: análisis de CVs, creación de descripciones de puestos, generación de preguntas de entrevista, 
evaluación de competencias, tendencias del mercado laboral y mejores prácticas de RRHH. 
Responde siempre de forma profesional, estructurada y en el idioma en que el usuario te escribe. 
Usa formato Markdown cuando sea útil (listas, tablas, encabezados). 
Si no tienes suficiente información para dar una respuesta precisa, pídela amablemente.`;

// ─── DOM References ────────────────────────────────────────────
const chatArea        = document.getElementById('chat-area');
const welcomeScreen   = document.getElementById('welcome-screen');
const userInput       = document.getElementById('user-input');
const sendBtn         = document.getElementById('send-btn');
const apiKeyInput     = document.getElementById('api-key-input');
const saveKeyBtn      = document.getElementById('save-key-btn');
const toggleKeyBtn    = document.getElementById('toggle-key-visibility');
const modelSelect     = document.getElementById('model-select');
const newChatBtn      = document.getElementById('new-chat-btn');
const clearChatBtn    = document.getElementById('clear-chat-btn');
const sidebarToggle   = document.getElementById('sidebar-toggle');
const sidebar         = document.getElementById('sidebar');
const historyList     = document.getElementById('history-list');
const statusDot       = document.getElementById('status-dot');
const statusText      = document.getElementById('status-text');
const charCount       = document.getElementById('char-count');
const toast           = document.getElementById('toast');
const promptChips     = document.querySelectorAll('.prompt-chip');
const canvas          = document.getElementById('particles-canvas');

// ─── Init ──────────────────────────────────────────────────────
(function init() {
  if (apiKey) {
    apiKeyInput.value = apiKey;
    setStatus('online');
  }
  loadSessionHistory();
  initParticles();

  // Auto-resize textarea
  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
    const len = userInput.value.length;
    charCount.textContent = len;
    sendBtn.disabled = len === 0 || isLoading;
  });

  // Send on Enter (Shift+Enter = newline)
  userInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);
  saveKeyBtn.addEventListener('click', saveApiKey);
  newChatBtn.addEventListener('click', startNewChat);
  clearChatBtn.addEventListener('click', clearChat);
  sidebarToggle.addEventListener('click', toggleSidebar);
  modelSelect.addEventListener('change', e => { model = e.target.value; showToast(`Modelo: ${model}`, 'info'); });

  toggleKeyBtn.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  });

  promptChips.forEach(chip => {
    chip.addEventListener('click', () => {
      userInput.value = chip.dataset.prompt;
      userInput.dispatchEvent(new Event('input'));
      userInput.focus();
    });
  });
})();

// ─── API Key ───────────────────────────────────────────────────
function saveApiKey() {
  const key = apiKeyInput.value.trim();
  if (!key) { showToast('Ingresa una API Key válida', 'error'); return; }
  apiKey = key;
  localStorage.setItem('recruit_ai_key', key);
  setStatus('online');
  showToast('API Key guardada exitosamente ✓', 'success');
}

// ─── Status ────────────────────────────────────────────────────
function setStatus(state) {
  statusDot.className = 'status-dot ' + state;
  const labels = { online:'Conectado', loading:'Generando...', '':'Sin conexión' };
  statusText.textContent = labels[state] || 'Sin conexión';
}

// ─── Send Message ──────────────────────────────────────────────
async function sendMessage() {
  const text = userInput.value.trim();
  if (!text || isLoading) return;

  if (!apiKey) {
    showToast('Por favor ingresa tu Google AI API Key en el panel izquierdo', 'error');
    return;
  }

  // Hide welcome screen
  if (welcomeScreen) welcomeScreen.style.display = 'none';

  // Render user bubble
  appendMessage('user', text);
  chatHistory.push({ role: 'user', parts: [{ text }] });

  // Clear input
  userInput.value = '';
  userInput.style.height = 'auto';
  charCount.textContent = '0';
  sendBtn.disabled = true;
  isLoading = true;
  setStatus('loading');

  // Show typing indicator
  const typingEl = appendTypingIndicator();

  try {
    const response = await callGeminiAPI(text);
    typingEl.remove();
    appendMessage('model', response);
    chatHistory.push({ role: 'model', parts: [{ text: response }] });
    saveCurrentSession(text);
    setStatus('online');
  } catch (err) {
    typingEl.remove();
    const errMsg = parseError(err);
    appendMessage('model', `⚠️ **Error:** ${errMsg}`, true);
    setStatus('online');
    showToast(errMsg, 'error');
  }

  isLoading = false;
  sendBtn.disabled = userInput.value.trim().length === 0;
  chatArea.scrollTop = chatArea.scrollHeight;
}

// ─── Gemini REST API ───────────────────────────────────────────
async function callGeminiAPI(userText) {
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`;

  // Build contents array (keep last 20 turns for context)
  const recentHistory = chatHistory.slice(-20);

  const body = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }]
    },
    contents: recentHistory,
    generationConfig: {
      temperature: 0.8,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 4096,
      candidateCount: 1
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
    ]
  };

  const res = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];

  if (!candidate) throw new Error('Sin respuesta del modelo.');
  if (candidate.finishReason === 'SAFETY') throw new Error('Respuesta bloqueada por filtros de seguridad.');

  return candidate.content?.parts?.[0]?.text || 'Sin contenido en la respuesta.';
}

// ─── Render Message ────────────────────────────────────────────
function appendMessage(role, text, isError = false) {
  const isUser = role === 'user';
  const wrapper = document.createElement('div');
  wrapper.className = `message ${isUser ? 'user-message' : 'ai-message'}`;

  const avatar = document.createElement('div');
  avatar.className = `message-avatar ${isUser ? 'user-avatar' : 'ai-avatar'}`;
  avatar.textContent = isUser ? 'TÚ' : 'RA';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${isUser ? 'user-bubble' : 'ai-bubble'}`;
  bubble.innerHTML = isUser ? escapeHtml(text).replace(/\n/g, '<br>') : renderMarkdown(text);

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = formatTime();

  if (!isUser) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.innerHTML = '📋 Copiar';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => showToast('Copiado al portapapeles ✓', 'success'));
    });
    meta.appendChild(copyBtn);
  }

  contentDiv.appendChild(bubble);
  contentDiv.appendChild(meta);
  wrapper.appendChild(avatar);
  wrapper.appendChild(contentDiv);

  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;
  return wrapper;
}

function appendTypingIndicator() {
  const wrapper = document.createElement('div');
  wrapper.className = 'message ai-message';
  wrapper.innerHTML = `
    <div class="message-avatar ai-avatar">RA</div>
    <div class="message-content">
      <div class="message-bubble ai-bubble">
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>
    </div>`;
  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;
  return wrapper;
}

// ─── Markdown Renderer ─────────────────────────────────────────
function renderMarkdown(text) {
  let html = escapeHtml(text);

  // Code blocks (before inline)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`);
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,   '<h1>$1</h1>');
  // Bold & italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g,         '<em>$1</em>');
  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr>');
  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Tables
  html = renderTable(html);
  // Unordered lists
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]+?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Paragraphs
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = `<p>${html}</p>`;
  // Clean empty <p>
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

function renderTable(text) {
  const tableRegex = /(\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)+)/g;
  return text.replace(tableRegex, match => {
    const rows = match.trim().split('\n');
    if (rows.length < 3) return match;
    const header = rows[0].split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
    const body   = rows.slice(2).map(r =>
      '<tr>' + r.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('') + '</tr>'
    ).join('');
    return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
  });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Session History ───────────────────────────────────────────
function saveCurrentSession(firstUserMsg) {
  const title = firstUserMsg.substring(0, 40) + (firstUserMsg.length > 40 ? '…' : '');
  if (!currentSessionId) {
    currentSessionId = Date.now().toString();
    sessionHistory.unshift({ id: currentSessionId, title, history: [...chatHistory] });
  } else {
    const s = sessionHistory.find(s => s.id === currentSessionId);
    if (s) s.history = [...chatHistory];
  }
  localStorage.setItem('recruit_sessions', JSON.stringify(sessionHistory.slice(0, 20)));
  renderHistoryList();
}

function loadSessionHistory() {
  const stored = localStorage.getItem('recruit_sessions');
  if (stored) {
    sessionHistory = JSON.parse(stored);
    renderHistoryList();
  }
}

function renderHistoryList() {
  historyList.innerHTML = '';
  sessionHistory.slice(0, 10).forEach(session => {
    const li = document.createElement('li');
    li.textContent = session.title;
    li.title = session.title;
    li.addEventListener('click', () => loadSession(session));
    historyList.appendChild(li);
  });
}

function loadSession(session) {
  clearChatDOM();
  if (welcomeScreen) welcomeScreen.style.display = 'none';
  currentSessionId = session.id;
  chatHistory = [...session.history];
  // Re-render messages
  chatHistory.forEach(msg => appendMessage(msg.role, msg.parts[0].text));
}

function startNewChat() {
  clearChatDOM();
  chatHistory = [];
  currentSessionId = null;
  if (welcomeScreen) welcomeScreen.style.display = '';
}

function clearChat() {
  clearChatDOM();
  chatHistory = [];
  if (welcomeScreen) welcomeScreen.style.display = '';
  showToast('Conversación limpiada', 'info');
}

function clearChatDOM() {
  const messages = chatArea.querySelectorAll('.message');
  messages.forEach(m => m.remove());
}

// ─── Sidebar Toggle ────────────────────────────────────────────
function toggleSidebar() {
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    sidebar.classList.toggle('mobile-open');
  } else {
    sidebar.classList.toggle('collapsed');
  }
}

// ─── Helpers ───────────────────────────────────────────────────
function formatTime() {
  return new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function parseError(err) {
  const msg = err.message || '';
  if (msg.includes('API_KEY_INVALID') || msg.includes('401')) return 'API Key inválida. Verifícala en el panel izquierdo.';
  if (msg.includes('QUOTA_EXCEEDED') || msg.includes('429'))  return 'Cuota de API agotada. Intenta más tarde.';
  if (msg.includes('404'))                                      return `Modelo "${model}" no disponible. Selecciona otro.`;
  if (msg.includes('Failed to fetch'))                         return 'Sin conexión a internet o CORS bloqueado.';
  return msg || 'Error desconocido al conectar con Gemini.';
}

let toastTimeout;
function showToast(msg, type = 'info') {
  toast.textContent = msg;
  toast.className = `toast show ${type}`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

// ─── Particle Background ───────────────────────────────────────
function initParticles() {
  const ctx = canvas.getContext('2d');
  let W = canvas.width  = window.innerWidth;
  let H = canvas.height = window.innerHeight;

  window.addEventListener('resize', () => {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  });

  const PARTICLE_COUNT = 60;
  const particles = Array.from({ length: PARTICLE_COUNT }, () => createParticle(W, H));

  function createParticle(w, h) {
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.8 + 0.3,
      dx: (Math.random() - 0.5) * 0.4,
      dy: (Math.random() - 0.5) * 0.4,
      alpha: Math.random() * 0.5 + 0.1,
      color: Math.random() > 0.6 ? '#d4a84b' : '#7c6dfa'
    };
  }

  function drawConnections() {
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i], b = particles[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist < 120) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = `rgba(212,168,75,${0.06 * (1 - dist / 120)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
  }

  function animate() {
    ctx.clearRect(0, 0, W, H);
    drawConnections();
    particles.forEach(p => {
      p.x += p.dx; p.y += p.dy;
      if (p.x < 0 || p.x > W) p.dx *= -1;
      if (p.y < 0 || p.y > H) p.dy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color + Math.round(p.alpha * 255).toString(16).padStart(2, '0');
      ctx.fill();
    });
    requestAnimationFrame(animate);
  }
  animate();
}
