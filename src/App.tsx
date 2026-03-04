import React, { useState, useEffect, useRef } from 'react';
import { Bot, User, Play, Square, Activity, Cpu, Server, Zap, Clock } from 'lucide-react';

const PROMPTS_PER_INSTANCE: Record<number, string[]> = {
  1: [
    "Explain the theory of relativity in simple terms.",
    "What is the speed of light?",
    "How does gravity work?",
    "What is a black hole?",
    "Explain time dilation."
  ],
  2: [
    "Write a short poem about a robot learning to love.",
    "Write a haiku about technology.",
    "Write a story about a futuristic city.",
    "Describe a world without internet.",
    "Write a dialogue between two AI."
  ],
  3: [
    "What are the main differences between classical and quantum computing?",
    "What is a qubit?",
    "Explain quantum entanglement.",
    "How does quantum computing change cryptography?",
    "What is the future of quantum computing?"
  ],
  4: [
    "Describe a futuristic city powered entirely by renewable energy.",
    "How can we achieve carbon neutrality?",
    "What are the benefits of solar energy?",
    "Explain the importance of wind energy.",
    "How does a smart grid work?"
  ]
};

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  metrics?: {
    evalCount: number;
    evalDuration: number;
    tokensPerSecond: number;
    totalDuration: number;
  };
}

function ChatbotInstance({ id, name, isAutoRunning, toggleAutoRun }: { id: number, name: string, isAutoRunning: boolean, toggleAutoRun: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  const [currentPromptIndex, setCurrentPromptIndex] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [metrics, setMetrics] = useState({
    totalTokens: 0,
    avgTokensPerSecond: 0,
    requestsCompleted: 0
  });

  const prompts = PROMPTS_PER_INSTANCE[id] || [];
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const autoRunRef = useRef(isAutoRunning);

  useEffect(() => {
    autoRunRef.current = isAutoRunning;
  }, [isAutoRunning]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, [id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const checkStatus = async () => {
    try {
      const res = await fetch(`/api/status/${id}`);
      const data = await res.json();
      setStatus(data.status);
    } catch (e) {
      setStatus('offline');
    }
  };

  const generateResponse = async (prompt: string) => {
    setIsGenerating(true);
    const userMsgId = Date.now().toString();
    setMessages(prev => [...prev, { id: userMsgId, role: 'user', content: prompt }]);

    try {
      const res = await fetch(`/api/chat/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });

      if (!res.ok) throw new Error('Failed to generate');
      
      const data = await res.json();
      
      const evalCount = data.tokens_predicted || 0;
      const evalDuration = (data.timings?.predicted_ms || 0) * 1e6; // convert ms to ns
      const totalDuration = ((data.timings?.predicted_ms || 0) + (data.timings?.prompt_ms || 0)) * 1e6;
      const tokensPerSecond = data.timings?.predicted_per_second || 0;

      const assistantMsgId = (Date.now() + 1).toString();
      setMessages(prev => [...prev, {
        id: assistantMsgId,
        role: 'assistant',
        content: data.content,
        metrics: {
          evalCount,
          evalDuration,
          tokensPerSecond,
          totalDuration
        }
      }]);

      setMetrics(prev => {
        const newTotalTokens = prev.totalTokens + evalCount;
        const newRequests = prev.requestsCompleted + 1;
        const newAvg = prev.avgTokensPerSecond === 0 
          ? tokensPerSecond 
          : ((prev.avgTokensPerSecond * prev.requestsCompleted) + tokensPerSecond) / newRequests;
        
        return {
          totalTokens: newTotalTokens,
          avgTokensPerSecond: newAvg,
          requestsCompleted: newRequests
        };
      });

    } catch (error) {
      console.error(error);
      setMessages(prev => [...prev, { 
        id: Date.now().toString(), 
        role: 'assistant', 
        content: `Error connecting to llama.cpp instance ${id}. Make sure it is running.` 
      }]);
      // Stop auto-run on error
      toggleAutoRun();
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const runCycle = async () => {
      if (!autoRunRef.current || isGenerating) return;

      if (currentPromptIndex >= prompts.length) {
        // Stop auto-run when finished
        if (autoRunRef.current) toggleAutoRun();
        return;
      }

      const prompt = prompts[currentPromptIndex];
      await generateResponse(prompt);
      
      const nextIndex = currentPromptIndex + 1;
      setCurrentPromptIndex(nextIndex);

      if (autoRunRef.current && nextIndex < prompts.length) {
        timeoutId = setTimeout(runCycle, 15000); // Wait 15s before next prompt
      } else {
        // Stop auto-run when finished
        if (autoRunRef.current) toggleAutoRun();
      }
    };

    if (isAutoRunning && !isGenerating) {
      runCycle();
    }

    return () => clearTimeout(timeoutId);
  }, [isAutoRunning, isGenerating, currentPromptIndex, prompts, toggleAutoRun]);

  return (
    <div className="bg-white border border-zinc-200 rounded-xl shadow-sm flex flex-col h-[600px] overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-zinc-100 bg-zinc-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Server className="w-5 h-5 text-zinc-500" />
          <div>
            <h2 className="font-semibold text-sm text-zinc-900">{name}</h2>
            <div className="flex items-center gap-2 mt-1">
              <div className={`w-2 h-2 rounded-full ${status === 'online' ? 'bg-emerald-500' : status === 'checking' ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
              <span className="text-[10px] uppercase tracking-wider font-mono text-zinc-500">{status}</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <div className="text-[10px] text-zinc-400 uppercase tracking-wider">Avg Speed</div>
            <div className="text-xs font-mono font-medium text-zinc-900">{metrics.avgTokensPerSecond.toFixed(1)} t/s</div>
          </div>
          <button
            onClick={toggleAutoRun}
            disabled={status !== 'online'}
            className={`p-2 rounded-lg transition-all ${
              isAutoRunning 
                ? 'bg-red-50 text-red-600 hover:bg-red-100' 
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
            title={isAutoRunning ? "Stop Auto-Prompt" : "Start Auto-Prompt"}
          >
            {isAutoRunning ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
          </button>
        </div>
      </div>
      
      {/* Chat Area - Split Panels */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-3">
            <Bot className="w-8 h-8 opacity-20" />
            <p className="text-sm text-center">Click play to start inference.</p>
          </div>
        ) : (
          messages.map((msg) => (
            <React.Fragment key={msg.id}>
              {/* Prompt Panel */}
              {msg.role === 'user' && (
                <div className="sticky top-0 z-20 bg-zinc-100 border border-zinc-200 rounded-lg p-3 text-xs text-zinc-700 font-medium shadow-sm">
                  {msg.content}
                </div>
              )}
              
              {/* Output Panel */}
              {msg.role === 'assistant' && (
                <div className="bg-white border border-zinc-200 rounded-lg p-3 shadow-sm">
                  <div className="flex items-center gap-2 mb-2">
                    <Bot className="w-4 h-4 text-zinc-400" />
                    <span className="text-[10px] font-semibold text-zinc-500 uppercase">Response</span>
                  </div>
                  <p className="text-xs text-zinc-800 leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  
                  {msg.metrics && (
                    <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-zinc-100 text-[10px] font-mono text-zinc-500">
                      <span className="flex items-center gap-1">
                        <Zap className="w-3 h-3 text-emerald-500" />
                        {msg.metrics.tokensPerSecond.toFixed(1)} t/s
                      </span>
                      <span className="flex items-center gap-1">
                        <Activity className="w-3 h-3 text-zinc-400" />
                        {msg.metrics.evalCount} tokens
                      </span>
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
          ))
        )}
        {isGenerating && (
          <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 p-2">
            <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-pulse"></span>
            GENERATING...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}

export default function App() {
  const [autoRunStates, setAutoRunStates] = useState<Record<number, boolean>>({
    1: false,
    2: false,
    3: false,
    4: false
  });

  const toggleAutoRun = (id: number) => {
    setAutoRunStates(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const runAll = () => {
    setAutoRunStates({
      1: true,
      2: true,
      3: true,
      4: true
    });
  };

  const stopAll = () => {
    setAutoRunStates({
      1: false,
      2: false,
      3: false,
      4: false
    });
  };

  const isAnyRunning = Object.values(autoRunStates).some(state => state);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Cpu className="w-8 h-8 text-zinc-900" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Ampere Density Cluster</h1>
              <p className="text-zinc-500 text-sm">4x Independent Qwen3-8B-GGUF Instances</p>
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={runAll}
              className="px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm font-medium hover:bg-zinc-800 transition-colors"
            >
              Run All
            </button>
            <button
              onClick={stopAll}
              className="px-4 py-2 bg-zinc-200 text-zinc-900 rounded-lg text-sm font-medium hover:bg-zinc-300 transition-colors"
            >
              Stop All
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 md:gap-6">
          <ChatbotInstance id={1} name="Instance 1 (Port 8080)" isAutoRunning={autoRunStates[1]} toggleAutoRun={() => toggleAutoRun(1)} />
          <ChatbotInstance id={2} name="Instance 2 (Port 8081)" isAutoRunning={autoRunStates[2]} toggleAutoRun={() => toggleAutoRun(2)} />
          <ChatbotInstance id={3} name="Instance 3 (Port 8082)" isAutoRunning={autoRunStates[3]} toggleAutoRun={() => toggleAutoRun(3)} />
          <ChatbotInstance id={4} name="Instance 4 (Port 8083)" isAutoRunning={autoRunStates[4]} toggleAutoRun={() => toggleAutoRun(4)} />
        </div>
      </div>
    </div>
  );
}
