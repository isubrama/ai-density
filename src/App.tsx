import React, { useState, useEffect, useRef } from 'react';
import { Bot, User, Play, Square, Activity, Cpu, Server, Zap, Clock } from 'lucide-react';

const PROMPTS_PER_INSTANCE: Record<number, Record<number, string[]>> = {
  1: {
    0: ["Explain the theory of relativity in simple terms.", "What is the speed of light?", "How does gravity work?", "What is a black hole?", "Explain time dilation."],
    1: ["What is the capital of France?", "Who wrote Hamlet?", "What is the largest planet?", "How many continents are there?", "What is the chemical symbol for water?"],
    2: ["Explain photosynthesis.", "What is DNA?", "How do vaccines work?", "What is the function of the heart?", "What is the human brain's main function?"],
    3: ["What is the history of the internet?", "Who invented the telephone?", "What was the first computer?", "What is artificial intelligence?", "How does a transistor work?"]
  },
  2: {
    0: ["Write a short poem about a robot learning to love.", "Write a haiku about technology.", "Write a story about a futuristic city.", "Describe a world without internet.", "Write a dialogue between two AI."],
    1: ["What is the best way to learn a new language?", "How do you improve memory?", "What are the benefits of reading?", "How does sleep affect learning?", "What is critical thinking?"],
    2: ["What is the importance of art?", "How does music affect the brain?", "What is the role of architecture?", "How does film influence culture?", "What is the purpose of literature?"],
    3: ["What is the future of space exploration?", "How do we colonize Mars?", "What are the challenges of space travel?", "What is the search for extraterrestrial life?", "What is the importance of space research?"]
  },
  3: {
    0: ["What are the main differences between classical and quantum computing?", "What is a qubit?", "Explain quantum entanglement.", "How does quantum computing change cryptography?", "What is the future of quantum computing?"],
    1: ["What is the impact of climate change?", "How can we reduce carbon emissions?", "What are the effects of global warming?", "What is renewable energy?", "What is sustainable development?"],
    2: ["What is the role of ethics in technology?", "How does AI impact privacy?", "What is the future of work?", "How does technology affect social interaction?", "What is the digital divide?"],
    3: ["What is the importance of biodiversity?", "How do ecosystems work?", "What is the impact of deforestation?", "What is conservation biology?", "How can we protect endangered species?"]
  },
  4: {
    0: ["Describe a futuristic city powered entirely by renewable energy.", "How can we achieve carbon neutrality?", "What are the benefits of solar energy?", "Explain the importance of wind energy.", "How does a smart grid work?"],
    1: ["What is the history of mathematics?", "Who invented calculus?", "What is the importance of statistics?", "How do we use geometry in daily life?", "What is the beauty of prime numbers?"],
    2: ["What is the philosophy of happiness?", "How do we define success?", "What is the meaning of life?", "How does stoicism help in modern life?", "What is the importance of mindfulness?"],
    3: ["What is the future of medicine?", "How does gene editing work?", "What is the role of nanotechnology in medicine?", "How do vaccines eradicate diseases?", "What is the importance of personalized medicine?"]
  }
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

function ChatbotInstance({ id, name }: { id: number, name: string }) {
  const [isAutoRunning, setIsAutoRunning] = useState(false);
  const [status, setStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  
  // 4 chatbots per instance
  const [chatbots, setChatbots] = useState(Array.from({ length: 4 }, (_, i) => ({
    id: i,
    messages: [] as Message[],
    currentPromptIndex: 0,
    isGenerating: false,
    metrics: { totalTokens: 0, avgTokensPerSecond: 0, requestsCompleted: 0 }
  })));

  const autoRunRef = useRef(isAutoRunning);
  useEffect(() => { autoRunRef.current = isAutoRunning; }, [isAutoRunning]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, [id]);

  const checkStatus = async () => {
    try {
      const res = await fetch(`/api/status/${id}`);
      const data = await res.json();
      setStatus(data.status);
    } catch (e) {
      setStatus('offline');
    }
  };

  const generateResponse = async (chatbotIndex: number, prompt: string) => {
    setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { ...cb, isGenerating: true } : cb));
    const userMsgId = Date.now().toString() + chatbotIndex;
    setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { ...cb, messages: [...cb.messages, { id: userMsgId, role: 'user', content: prompt }] } : cb));

    try {
      const res = await fetch(`/api/chat/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });

      if (!res.ok) throw new Error('Failed to generate');
      
      const data = await res.json();
      
      const evalCount = data.tokens_predicted || 0;
      const tokensPerSecond = data.timings?.predicted_per_second || 0;

      const assistantMsgId = (Date.now() + 1).toString() + chatbotIndex;
      setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { 
        ...cb, 
        messages: [...cb.messages, {
          id: assistantMsgId,
          role: 'assistant',
          content: data.content,
          metrics: {
            evalCount,
            evalDuration: (data.timings?.predicted_ms || 0) * 1e6,
            tokensPerSecond,
            totalDuration: ((data.timings?.predicted_ms || 0) + (data.timings?.prompt_ms || 0)) * 1e6
          }
        }],
        metrics: {
          totalTokens: cb.metrics.totalTokens + evalCount,
          requestsCompleted: cb.metrics.requestsCompleted + 1,
          avgTokensPerSecond: cb.metrics.avgTokensPerSecond === 0 
            ? tokensPerSecond 
            : ((cb.metrics.avgTokensPerSecond * cb.metrics.requestsCompleted) + tokensPerSecond) / (cb.metrics.requestsCompleted + 1)
        }
      } : cb));

    } catch (error) {
      console.error(error);
      setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { 
        ...cb, 
        messages: [...cb.messages, { 
          id: Date.now().toString(), 
          role: 'assistant', 
          content: `Error connecting to llama.cpp instance ${id}.` 
        }]
      } : cb));
    } finally {
      setChatbots(prev => prev.map((cb, i) => i === chatbotIndex ? { ...cb, isGenerating: false } : cb));
    }
  };

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const runCycle = async () => {
      if (!autoRunRef.current) return;

      const promises = chatbots.map(async (cb, index) => {
        const chatbotPrompts = PROMPTS_PER_INSTANCE[id][index];
        if (cb.isGenerating || cb.currentPromptIndex >= chatbotPrompts.length) return;
        
        const prompt = chatbotPrompts[cb.currentPromptIndex];
        await generateResponse(index, prompt);
        
        setChatbots(prev => prev.map((c, i) => i === index ? { ...c, currentPromptIndex: c.currentPromptIndex + 1 } : c));
      });

      await Promise.all(promises);

      if (autoRunRef.current && chatbots.some(cb => cb.currentPromptIndex < PROMPTS_PER_INSTANCE[id][cb.id].length)) {
        timeoutId = setTimeout(runCycle, 15000);
      } else {
        setIsAutoRunning(false);
      }
    };

    if (isAutoRunning) {
      runCycle();
    }

    return () => clearTimeout(timeoutId);
  }, [isAutoRunning, chatbots, id]);

  const toggleAutoRun = () => {
    setIsAutoRunning(!isAutoRunning);
  };

  return (
    <div className="bg-white border border-zinc-200 rounded-xl shadow-sm flex flex-col h-[800px] overflow-hidden">
      <div className="p-4 border-b border-zinc-100 bg-zinc-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Server className="w-5 h-5 text-zinc-500" />
          <h2 className="font-semibold text-sm text-zinc-900">{name}</h2>
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${status === 'online' ? 'bg-emerald-500' : status === 'checking' ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
            <span className="text-[10px] font-semibold text-zinc-500 uppercase">{status}</span>
          </div>
        </div>
        <button
          onClick={toggleAutoRun}
          disabled={status !== 'online'}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            isAutoRunning ? 'bg-red-50 text-red-600' : 'bg-zinc-900 text-white'
          }`}
        >
          {isAutoRunning ? 'Stop' : 'Run'}
        </button>
      </div>
      
      <div className="flex-1 grid grid-cols-2 gap-2 p-2 overflow-y-auto">
        {chatbots.map((cb, index) => (
          <div key={index} className="border border-zinc-100 rounded-lg flex flex-col overflow-hidden bg-zinc-50">
            <div className="p-2 border-b border-zinc-100 text-[10px] font-semibold text-zinc-500 uppercase">Chatbot {index + 1}</div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {cb.messages.map(msg => (
                <div key={msg.id} className="text-xs">
                  {msg.role === 'user' ? (
                    <div className="bg-zinc-200 p-2 rounded">{msg.content}</div>
                  ) : (
                    <div className="bg-white p-2 rounded border border-zinc-100">{msg.content}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <Cpu className="w-8 h-8 text-zinc-900" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Ampere Density Cluster</h1>
            <p className="text-zinc-500 text-sm">4x Independent Qwen3-8B-GGUF Instances (4 Chatbots per Instance)</p>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-6">
          <ChatbotInstance id={1} name="Instance 1 (Port 8080)" />
          <ChatbotInstance id={2} name="Instance 2 (Port 8081)" />
          <ChatbotInstance id={3} name="Instance 3 (Port 8082)" />
          <ChatbotInstance id={4} name="Instance 4 (Port 8083)" />
        </div>
      </div>
    </div>
  );
}
