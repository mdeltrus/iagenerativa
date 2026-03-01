/* ============================================================
   RecruitAI — App Logic
   Google Generative AI (Gemini) REST API + File Upload
   ============================================================ */

'use strict';

// ─── State ────────────────────────────────────────────────────
// __IA_API_KEY__ es reemplazado en tiempo de despliegue por el workflow de GitHub Actions.
// Localmente se puede seguir usando localStorage como fallback.
const _INJECTED_KEY = '__IA_API_KEY__';
let apiKey = (_INJECTED_KEY && !_INJECTED_KEY.startsWith('__'))
    ? _INJECTED_KEY
    : (localStorage.getItem('recruit_ai_key') || '');
let model = 'gemini-2.5-flash';
let chatHistory = [];         // { role:'user'|'model', parts:[...] }
let sessionHistory = [];        // [{id, title, history}]
let isLoading = false;
let currentSessionId = null;
let attachedFile = null;       // { name, type:'pdf'|'docx'|'odt'|'doc', base64?, text?, mimeType? }

const SYSTEM_PROMPT = `Eres RecruitAI, un asistente experto en reclutamiento y gestión de talento humano.
Tu especialidad incluye: análisis de CVs, creación de descripciones de puestos, generación de preguntas de entrevista,
evaluación de competencias, tendencias del mercado laboral y mejores prácticas de RRHH.
Cuando el usuario adjunte un CV o documento, analízalo con detalle: extrae datos clave, evalúa experiencia,
habilidades y formación, e indica fortalezas y áreas de mejora.
Responde siempre de forma profesional, estructurada y en el idioma en que el usuario te escribe.
Usa formato Markdown cuando sea útil (listas, tablas, encabezados).
Si no tienes suficiente información para dar una respuesta precisa, pídela amablemente.`;

// ─── DOM References ────────────────────────────────────────────
const chatArea = document.getElementById('chat-area');
const welcomeScreen = document.getElementById('welcome-screen');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const clearChatBtn = document.getElementById('clear-chat-btn');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const historyList = document.getElementById('history-list');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const charCount = document.getElementById('char-count');
const toast = document.getElementById('toast');
const promptChips = document.querySelectorAll('.prompt-chip');
const canvas = document.getElementById('particles-canvas');
// File upload
const fileInput = document.getElementById('file-input');
const attachBtn = document.getElementById('attach-btn');
const fileChipRow = document.getElementById('file-chip-row');
const fileChipEl = document.getElementById('file-chip');
const fileChipName = document.getElementById('file-chip-name');
const fileChipSize = document.getElementById('file-chip-size');
const fileChipIcon = document.getElementById('file-chip-icon');
const fileChipRemove = document.getElementById('file-chip-remove');
const dropOverlay = document.getElementById('drop-overlay');

// ─── Init ──────────────────────────────────────────────────────
(function init() {
    if (apiKey) setStatus('online');
    loadSessionHistory();
    initParticles();

    // Auto-resize textarea
    userInput.addEventListener('input', () => {
        userInput.style.height = 'auto';
        userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
        const len = userInput.value.length;
        charCount.textContent = len;
        sendBtn.disabled = (len === 0 && !attachedFile) || isLoading;
    });

    // Send on Enter (Shift+Enter = newline)
    userInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!sendBtn.disabled) sendMessage();
        }
    });

    sendBtn.addEventListener('click', sendMessage);
    newChatBtn.addEventListener('click', startNewChat);
    clearChatBtn.addEventListener('click', clearChat);
    sidebarToggle.addEventListener('click', toggleSidebar);

    // ─ File upload ─
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
        if (e.target.files[0]) handleFileSelect(e.target.files[0]);
        fileInput.value = '';
    });
    fileChipRemove.addEventListener('click', clearFile);

    // Drag & Drop
    document.addEventListener('dragover', e => { e.preventDefault(); dropOverlay.classList.add('active'); });
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) dropOverlay.classList.remove('active'); });
    document.addEventListener('drop', e => {
        e.preventDefault();
        dropOverlay.classList.remove('active');
        const file = e.dataTransfer.files?.[0];
        if (file) handleFileSelect(file);
    });

    promptChips.forEach(chip => {
        chip.addEventListener('click', () => {
            userInput.value = chip.dataset.prompt;
            userInput.dispatchEvent(new Event('input'));
            userInput.focus();
        });
    });
})();

// ─── API Key (solo desarrollo local) ───────────────────────────
function saveApiKey(key) {
    if (!key) { showToast('Ingresa una API Key válida', 'error'); return; }
    apiKey = key;
    localStorage.setItem('recruit_ai_key', key);
    setStatus('online');
    showToast('API Key guardada exitosamente ✓', 'success');
}

// ─── Status ────────────────────────────────────────────────────
function setStatus(state) {
    statusDot.className = 'status-dot ' + state;
    const labels = { online: 'Conectado', loading: 'Generando...', '': 'Sin conexión' };
    statusText.textContent = labels[state] || 'Sin conexión';
}

// ─── File Upload ───────────────────────────────────────────────
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const FILE_ICONS = { pdf: '📕', docx: '📄', doc: '📄', odt: '📝', ott: '📝' };

async function handleFileSelect(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['pdf', 'doc', 'docx', 'odt', 'ott'].includes(ext)) {
        showToast(`Formato no soportado: .${ext}. Usa PDF, DOCX, ODT o DOC.`, 'error');
        return;
    }
    if (file.size > MAX_FILE_BYTES) {
        showToast('Archivo demasiado grande (máx. 10 MB).', 'error');
        return;
    }
    setFileChip(file.name, formatFileSize(file.size), FILE_ICONS[ext] || '📄', true);
    try {
        await processFile(file, ext);
        setFileChip(file.name, formatFileSize(file.size), FILE_ICONS[ext] || '📄', false);
        attachBtn.classList.add('has-file');
        sendBtn.disabled = isLoading;
        showToast(`Archivo listo: ${file.name}`, 'success');
    } catch (err) {
        clearFile();
        showToast(`Error procesando archivo: ${err.message}`, 'error');
    }
}

async function processFile(file, ext) {
    const arrayBuffer = await file.arrayBuffer();
    if (ext === 'pdf') {
        attachedFile = {
            name: file.name,
            type: 'pdf',
            mimeType: 'application/pdf',
            base64: arrayBufferToBase64(arrayBuffer)
        };
    } else if (ext === 'docx') {
        if (typeof mammoth === 'undefined') throw new Error('mammoth.js no cargó. Verifica tu conexión a internet.');
        const result = await mammoth.extractRawText({ arrayBuffer });
        if (!result.value) throw new Error('No se pudo extraer texto del DOCX.');
        attachedFile = { name: file.name, type: 'docx', text: result.value };
    } else if (ext === 'odt' || ext === 'ott') {
        if (typeof JSZip === 'undefined') throw new Error('JSZip no cargó. Verifica tu conexión a internet.');
        const text = await extractOdtText(arrayBuffer);
        if (!text) throw new Error('No se pudo extraer texto del ODT.');
        attachedFile = { name: file.name, type: 'odt', text };
    } else {
        // .doc legacy binary — best-effort text extraction
        const text = extractDocText(arrayBuffer);
        if (!text) throw new Error('Archivo .doc sin texto legible. Conviértelo a DOCX o PDF para mejores resultados.');
        attachedFile = { name: file.name, type: 'doc', text };
    }
}

async function extractOdtText(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const contentFile = zip.file('content.xml');
    if (!contentFile) throw new Error('Archivo ODT inválido (sin content.xml).');
    const xml = await contentFile.async('text');
    return xml
        .replace(/<text:line-break[^>]*\/>/g, '\n')
        .replace(/<text:p[^>]*>/g, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function extractDocText(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let text = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if ((b >= 32 && b < 127) || b === 10 || b === 13) text += String.fromCharCode(b);
    }
    return text.replace(/[^ -~\n\r]+/g, ' ').replace(/ {3,}/g, '  ').trim();
}

function arrayBufferToBase64(buffer) {
    let bin = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function setFileChip(name, size, icon, processing) {
    fileChipIcon.textContent = icon;
    fileChipName.textContent = name;
    fileChipSize.textContent = size;
    fileChipEl.classList.toggle('processing', processing);
    fileChipRow.style.display = '';
}

function clearFile() {
    attachedFile = null;
    fileChipRow.style.display = 'none';
    fileChipEl.classList.remove('processing');
    attachBtn.classList.remove('has-file');
    sendBtn.disabled = userInput.value.trim().length === 0 || isLoading;
}

// ─── Send Message ──────────────────────────────────────────────
async function sendMessage() {
    const text = userInput.value.trim();
    if (!text && !attachedFile) return;
    if (isLoading) return;

    if (!apiKey) {
        showToast('Por favor ingresa tu Google AI API Key en el panel izquierdo', 'error');
        return;
    }

    if (welcomeScreen) welcomeScreen.style.display = 'none';

    // Snapshot file before clearing
    const currentFile = attachedFile;

    // Build multipart message for Gemini
    const currentParts = [];
    if (currentFile && currentFile.type === 'pdf') {
        // PDF goes as inline binary data — Gemini reads it natively
        currentParts.push({
            inline_data: { mime_type: currentFile.mimeType, data: currentFile.base64 }
        });
    }
    // Build the text part (embed extracted text for non-PDF docs)
    let msgText;
    if (text && currentFile && currentFile.type !== 'pdf') {
        msgText = `${text}\n\n---\n**Documento adjunto:** ${currentFile.name}\n\n${currentFile.text}`;
    } else if (!text && currentFile && currentFile.type !== 'pdf') {
        msgText = `Analiza el siguiente documento y proporciona un resumen profesional de su contenido.\n\n**Documento:** ${currentFile.name}\n\n${currentFile.text}`;
    } else if (!text && currentFile && currentFile.type === 'pdf') {
        msgText = 'Analiza el documento PDF adjunto y proporciona un resumen profesional de su contenido.';
    } else {
        msgText = text;
    }
    currentParts.push({ text: msgText });

    // Display text for user bubble
    const fileLabel = currentFile ? ` 📎 *${currentFile.name}*` : '';
    const displayBubble = text ? text + fileLabel : `📎 ${currentFile.name}`;
    appendMessage('user', displayBubble);
    chatHistory.push({ role: 'user', parts: currentParts });

    // Reset input & file
    userInput.value = '';
    userInput.style.height = 'auto';
    charCount.textContent = '0';
    clearFile();
    sendBtn.disabled = true;
    isLoading = true;
    setStatus('loading');

    const typingEl = appendTypingIndicator();
    try {
        const response = await callGeminiAPI();
        typingEl.remove();
        appendMessage('model', response);
        chatHistory.push({ role: 'model', parts: [{ text: response }] });
        saveCurrentSession(text || (currentFile ? currentFile.name : ''));
        setStatus('online');
    } catch (err) {
        typingEl.remove();
        const errMsg = parseError(err);
        appendMessage('model', `⚠️ **Error:** ${errMsg}`, true);
        setStatus('online');
        showToast(errMsg, 'error');
    }
    isLoading = false;
    sendBtn.disabled = userInput.value.trim().length === 0 && !attachedFile;
    chatArea.scrollTop = chatArea.scrollHeight;
}

// ─── Gemini REST API ───────────────────────────────────────────
// chatHistory already contains the current user turn at call time
async function callGeminiAPI() {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const recentHistory = chatHistory.slice(-20);

    const body = {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: recentHistory,
        generationConfig: {
            temperature: 0.8,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 4096,
            candidateCount: 1
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
        ]
    };

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
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
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
        `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/^---$/gm, '<hr>');
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    html = renderTable(html);
    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>[\s\S]+?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    html = html.replace(/\n\n+/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = `<p>${html}</p>`;
    html = html.replace(/<p>\s*<\/p>/g, '');
    return html;
}

function renderTable(text) {
    const tableRegex = /(\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)+)/g;
    return text.replace(tableRegex, match => {
        const rows = match.trim().split('\n');
        if (rows.length < 3) return match;
        const header = rows[0].split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
        const body = rows.slice(2).map(r =>
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
function saveCurrentSession(firstMsg) {
    const title = firstMsg.substring(0, 40) + (firstMsg.length > 40 ? '…' : '');
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
    chatHistory.forEach(msg => appendMessage(msg.role, msg.parts.find(p => p.text)?.text || ''));
}

function startNewChat() {
    clearChatDOM();
    chatHistory = [];
    currentSessionId = null;
    clearFile();
    if (welcomeScreen) welcomeScreen.style.display = '';
}

function clearChat() {
    clearChatDOM();
    chatHistory = [];
    clearFile();
    if (welcomeScreen) welcomeScreen.style.display = '';
    showToast('Conversación limpiada', 'info');
}

function clearChatDOM() {
    chatArea.querySelectorAll('.message').forEach(m => m.remove());
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
    if (msg.includes('QUOTA_EXCEEDED') || msg.includes('429')) return 'Cuota de API agotada. Intenta más tarde.';
    if (msg.includes('404')) return `Modelo "${model}" no disponible. Selecciona otro.`;
    if (msg.includes('Failed to fetch')) return 'Sin conexión a internet o CORS bloqueado.';
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
    let W = canvas.width = window.innerWidth;
    let H = canvas.height = window.innerHeight;

    window.addEventListener('resize', () => {
        W = canvas.width = window.innerWidth;
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
