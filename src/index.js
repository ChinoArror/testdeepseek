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
    </style>
</head>
<body>
    <h1>DeepSeek Chat</h1>
    <div class="config-panel">
        <input type="text" id="apiKey" placeholder="API Key">
        <select id="model">
            <option value="deepseek-r1">deepseek-r1</option>
        </select>
        <input type="number" id="temperature" value="0.7" step="0.1" placeholder="Temperature">
        <button onclick="startChat()">Start Chat</button>
    </div>
    <div class="chat-container">
        <div id="chat-box"></div>
        <div class="input-area">
            <input type="text" id="userInput" placeholder="输入消息...">
            <button onclick="sendMessage()">发送</button>
        </div>
    </div>

    <script>
        let chatHistory = [];
        
        function appendMessage(role, content) {
            const chatBox = document.getElementById('chat-box');
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role}-message\`;
            messageDiv.innerHTML = content.replace(/\$\$(.*?)\$\$/g, '<div>\$1</div>')
                                        .replace(/\$(.*?)\$/g, '\$1');
            chatBox.appendChild(messageDiv);
            chatBox.scrollTop = chatBox.scrollHeight;
        }

        async function sendMessage() {
            const userInput = document.getElementById('userInput');
            const message = userInput.value.trim();
            if (!message) return;

            appendMessage('user', message);
            userInput.value = '';
            
            try {
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: [...chatHistory, { role: 'user', content: message }],
                        apiKey: document.getElementById('apiKey').value,
                        model: document.getElementById('model').value,
                        temperature: parseFloat(document.getElementById('temperature').value)
                    })
                });

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let botMessage = '';
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value);
                    const events = chunk.split('\\n\\n');
                    
                    for (const event of events.filter(e => e)) {
                        if (event.startsWith('data: ')) {
                            botMessage += event.slice(6);
                            appendMessage('bot', botMessage);
                        }
                    }
                }
                
                chatHistory.push({ role: 'assistant', content: botMessage });
            } catch (error) {
                appendMessage('error', \`Error: \${error.message}\`);
            }
        }
    </script>
</body>
</html>
`;

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};

async function handleChatRequest(request) {
    try {
        const { messages, apiKey, model = 'deepseek-r1', temperature = 0.7 } = await request.json();

        const stream = new TransformStream();
        const writer = stream.writable.getWriter();
        const encoder = new TextEncoder();

        const deepseekRequest = {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey || (typeof DEFAULT_API_KEY !== 'undefined' ? DEFAULT_API_KEY : '')}`
            },
            body: JSON.stringify({
                model,
                messages,
                temperature,
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

                    buffer += new TextDecoder().decode(value);
                    
                    const parts = buffer.split("\n\n");
                    buffer = parts.pop();

                    for (const part of parts) {
                        const chunk = part.replace(/^data: /, "").trim();
                        if (chunk === "[DONE]") break;

                        try {
                            const data = JSON.parse(chunk);
                            const content = data.choices[0].delta.content || "";
                            const processed = content.replace(
                                /\\\\([\(\)\[\]])/g, 
                                (match, p1) => ({
                                    '\\\\(': '$',
                                    '\\\\)': '$',
                                    '\\\\\\[': '$$',
                                    '\\\\\\]': '$$'
                                })[match] || p1
                            );
                            
                            if (processed) {
                                await writer.write(encoder.encode(`data: ${processed}\n\n`));
                            }
                        } catch (e) {
                            console.error("Error parsing chunk:", e);
                        }
                    }
                }

                await writer.close();
            })
            .catch(async (error) => {
                await writer.write(encoder.encode(`error: ${error.message}\n\n`));
                await writer.close();
            });

        return new Response(stream.readable, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
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
