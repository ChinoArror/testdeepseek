const HTML_CONTENT = `
<!DOCTYPE html>
<html>
<head>
    <title>DeepSeek Chat</title>
    <meta charset="UTF-8">
    <style>
        :root { --primary: #2d3748; }
        body { 
            max-width: 800px; 
            margin: 0 auto; 
            padding: 20px;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .chat-container {
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 20px;
            margin-top: 20px;
        }
        #chat-box {
            height: 500px;
            overflow-y: auto;
            padding: 10px;
            border: 1px solid #e2e8f0;
            border-radius: 4px;
            margin: 10px 0;
        }
        .message {
            margin: 10px 0;
            padding: 12px;
            border-radius: 6px;
        }
        .user-message { background: #f7fafc; }
        .bot-message { background: #ebf8ff; }
        .math { color: #2d3748; font-family: monospace; }
        .error-message { background: #fff5f5; color: #c53030; }
        .config-panel {
            display: grid;
            grid-gap: 10px;
            grid-template-columns: 1fr 1fr;
            margin-bottom: 20px;
        }
        input, select, button {
            padding: 8px 12px;
            border: 1px solid #e2e8f0;
            border-radius: 4px;
        }
        button {
            background: var(--primary);
            color: white;
            cursor: pointer;
        }
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
    </style>
</head>
<body>
    <h1>DeepSeek Chat</h1>
    <div class="config-panel">
        <select id="model">
            <option value="deepseek-r1">deepseek-r1</option>
        </select>
        <input type="number" id="temperature" value="0.7" step="0.1" placeholder="Temperature">
        <button onclick="initSecureSession()">🔒 初始化安全会话</button>
    </div>
    <div class="chat-container">
        <div id="chat-box"></div>
        <div class="input-area">
            <input type="text" id="userInput" placeholder="输入消息..." disabled>
            <button onclick="sendMessage()" id="sendBtn" disabled>发送</button>
        </div>
    </div>

    <script>
        let chatHistory = [];
        let sessionNonce = null;
        
        async function initSecureSession() {
            const password = prompt("设置会话密码（用于本地加密）:");
            if (password && password.length >= 8) {
                sessionNonce = crypto.getRandomValues(new Uint8Array(12));
                document.getElementById('userInput').disabled = false;
                document.getElementById('sendBtn').disabled = false;
            }
        }

        async function encryptMessage(content) {
            const encoded = new TextEncoder().encode(content);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv },
                ENCRYPTION_KEY,
                encoded
            );
            return {
                iv: Array.from(iv),
                data: Array.from(new Uint8Array(encrypted)),
                nonce: Array.from(sessionNonce)
            };
        }

        function appendMessage(role, content) {
            const chatBox = document.getElementById('chat-box');
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role}-message\`;
            messageDiv.innerHTML = content
                .replace(/\$\$(.*?)\$\$/g, '<div class="math">\$1</div>')
                .replace(/\$(.*?)\$/g, '<span class="math">\$1</span>');
            chatBox.appendChild(messageDiv);
            chatBox.scrollTop = chatBox.scrollHeight;
        }

        async function sendMessage() {
            const userInput = document.getElementById('userInput');
            const message = userInput.value.trim();
            if (!message || !sessionNonce) return;

            userInput.disabled = true;
            appendMessage('user', message);
            userInput.value = '';
            
            try {
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-Session-Nonce': Array.from(sessionNonce).join(',')
                    },
                    body: JSON.stringify({
                        message: await encryptMessage(message),
                        model: document.getElementById('model').value,
                        temperature: parseFloat(document.getElementById('temperature').value)
                    })
                });

                if (!response.ok) throw new Error(\`请求失败: \${response.status}\`);
                
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let botMessage = '';
                let messageDiv = null;
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value);
                    const events = chunk.split('\\n\\n');
                    
                    for (const event of events.filter(e => e)) {
                        if (event.startsWith('data: ')) {
                            const content = event.slice(6);
                            if (!messageDiv) {
                                messageDiv = document.createElement('div');
                                messageDiv.className = 'message bot-message';
                                document.getElementById('chat-box').appendChild(messageDiv);
                            }
                            botMessage += content;
                            messageDiv.innerHTML = botMessage
                                .replace(/\$\$(.*?)\$\$/g, '<div class="math">\$1</div>')
                                .replace(/\$(.*?)\$/g, '<span class="math">\$1</span>');
                            messageDiv.scrollIntoView({ behavior: 'smooth' });
                        }
                    }
                }
                
                chatHistory.push({ role: 'assistant', content: botMessage });
            } catch (error) {
                appendMessage('error', \`错误: \${error.message}\`);
            } finally {
                userInput.disabled = false;
            }
        }
    </script>
</body>
</html>
`;

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Session-Nonce"
};

async function handleChatRequest(request) {
    try {
        const data = await request.json();
        const nonceHeader = request.headers.get('X-Session-Nonce');
        
        // 解密消息
        const decryptedMessage = await decryptMessage(
            data.message,
            new Uint8Array(nonceHeader.split(',').map(Number))
        );

        // 使用全局加密的API Key
        const apiKey = await decryptStoredKey();

        const stream = new TransformStream();
        const writer = stream.writable.getWriter();
        const encoder = new TextEncoder();

        const deepseekRequest = {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: data.model,
                messages: [{ role: "user", content: decryptedMessage }],
                temperature: data.temperature,
                stream: true
            })
        };

        fetch("https://api.deepseek.com/v1/chat/completions", deepseekRequest)
            .then(async (response) => {
                const reader = response.body.getReader();
                let buffer = "";
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += new TextDecoder().decode(value, { stream: true });
                    const chunks = buffer.split("\\n");
                    buffer = chunks.pop() || "";

                    for (const chunk of chunks) {
                        const content = chunk.replace(/^data: /, "").trim();
                        if (!content || content === "[DONE]") continue;
                        
                        try {
                            const jsonData = JSON.parse(content);
                            if (jsonData.choices[0].delta?.content) {
                                const processed = jsonData.choices[0].delta.content
                                    .replace(/\\\\([()\\[\\]])/g, (_, p1) => 
                                        ({ '(': '$', ')': '$', '[': '$$', ']': '$$' }[p1]));
                                
                                await writer.write(encoder.encode(`data: \${processed}\n\n`));
                            }
                        } catch (e) {
                            console.error("Stream parse error:", e);
                        }
                    }
                }
                await writer.close();
            })
            .catch(async (error) => {
                await writer.write(encoder.encode(\`error: \${error.message}\\n\\n\`));
                await writer.close();
            });

        return new Response(stream.readable, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                ...corsHeaders
            }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: corsHeaders
        });
    }
}

// Helpers
async function decryptMessage({ iv, data }, nonce) {
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv), additionalData: nonce },
        ENCRYPTION_KEY,
        new Uint8Array(data)
    );
    return new TextDecoder().decode(decrypted);
}

async function decryptStoredKey() {
    const encrypted = await ENCRYPTED_STORAGE.get("api_key");
    const { iv, data } = JSON.parse(encrypted);
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        ENCRYPTION_KEY,
        new Uint8Array(data)
    );
    return new TextDecoder().decode(decrypted);
}

async function handleRequest(request) {
    const url = new URL(request.url);
    
    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/api/chat") {
        return handleChatRequest(request);
    }

    return new Response(HTML_CONTENT, {
        headers: { 
            "Content-Type": "text/html",
            ...corsHeaders
        }
    });
}

export default {
    fetch: handleRequest
};
