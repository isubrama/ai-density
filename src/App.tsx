import React, { useState, useEffect, useRef } from 'react';
import { Bot, User, Play, Square, Activity, Cpu, Server, Zap, Clock } from 'lucide-react';

const PROMPTS_PER_INSTANCE: Record<number, Record<number, string[]>> = {
  1: {
    0: ["Explain the theory of relativity in simple terms.", "What is the speed of light?", "How does gravity work?", "What is a black hole?", "Explain time dilation."],
    1: ["What is the capital of France?", "Who wrote Hamlet?", "What is the largest planet?", "How many continents are there?", "What is the chemical symbol for water?"],
    2: ["Explain photosynthesis.", "What is DNA?", "How do vaccines work?", "What is the function of the heart?", "What is the human brain's main function?"],
    3: ["What is the history of the internet?", "Who invented the telephone?", "What was the first computer?", "What is artificial intelligence?", "How does a transistor work?"],
    4: ["Explain how a blockchain works.", "What is the difference between SQL and NoSQL?", "What is cloud computing?", "How does a load balancer work?", "What is a microservice architecture?"]
  },
  2: {
    0: ["Write a short poem about a robot learning to love.", "Write a haiku about technology.", "Write a story about a futuristic city.", "Describe a world without internet.", "Write a dialogue between two AI."],
    1: ["What is the best way to learn a new language?", "How do you improve memory?", "What are the benefits of reading?", "How does sleep affect learning?", "What is critical thinking?"],
    2: ["What is the importance of art?", "How does music affect the brain?", "What is the role of architecture?", "How does film influence culture?", "What is the purpose of literature?"],
    3: ["What is the future of space exploration?", "How do we colonize Mars?", "What are the challenges of space travel?", "What is the search for extraterrestrial life?", "What is the importance of space research?"],
    4: ["Explain the concept of time travel in fiction.", "What is the Fermi paradox?", "How do we detect exoplanets?", "What is dark matter?", "What is the Big Bang theory?"]
  },
  3: {
    0: ["What are the main differences between classical and quantum computing?", "What is a qubit?", "Explain quantum entanglement.", "How does quantum computing change cryptography?", "What is the future of quantum computing?"],
    1: ["What is the impact of climate change?", "How can we reduce carbon emissions?", "What are the effects of global warming?", "What is renewable energy?", "What is sustainable development?"],
    2: ["What is the role of ethics in technology?", "How does AI impact privacy?", "What is the future of work?", "How does technology affect social interaction?", "What is the digital divide?"],
    3: ["What is the importance of biodiversity?", "How do ecosystems work?", "What is the impact of deforestation?", "What is conservation biology?", "How can we protect endangered species?"],
    4: ["What is the future of urban planning?", "How do smart cities work?", "What are the benefits of public transportation?", "How can we improve urban air quality?", "What is the importance of green spaces?"]
  },
  4: {
    0: ["Describe a futuristic city powered entirely by renewable energy.", "How can we achieve carbon neutrality?", "What are the benefits of solar energy?", "Explain the importance of wind energy.", "How does a smart grid work?"],
    1: ["What is the history of mathematics?", "Who invented calculus?", "What is the importance of statistics?", "How do we use geometry in daily life?", "What is the beauty of prime numbers?"],
    2: ["What is the philosophy of happiness?", "How do we define success?", "What is the meaning of life?", "How does stoicism help in modern life?", "What is the importance of mindfulness?"],
    3: ["What is the future of medicine?", "How does gene editing work?", "What is the role of nanotechnology in medicine?", "How do vaccines eradicate diseases?", "What is the importance of personalized medicine?"],
    4: ["What is the impact of social media on society?", "How does misinformation spread?", "What is the role of journalism in democracy?", "How can we promote media literacy?", "What is the future of communication?"]
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
  
  // 5 chatbots per instance
  const [chatbots, setChatbots] = useState(Array.from({ length: 5 }, (_, i) => ({
    id: i,
    messages: [] as Message[],
    currentPromptIndex: 0,
    isGenerating: false,
    metrics: { totalTokens: 0, avgTokensPerSecond: 0, requestsCompleted: 0 }
  })));

  const messageRefs = useRef<(HTMLDivElement | null)[]>(Array(5).fill(null));
  const promptRefs = useRef<(HTMLDivElement | null)[]>(Array(5).fill(null));

  useEffect(() => {
    chatbots.forEach((cb, index) => {
      if (messageRefs.current[index]) {
        messageRefs.current[index]!.scrollTop = messageRefs.current[index]!.scrollHeight;
      }
      if (promptRefs.current[index]) {
        promptRefs.current[index]!.scrollTop = promptRefs.current[index]!.scrollHeight;
      }
    });
  }, [chatbots]);

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
        timeoutId = setTimeout(runCycle, 300000);
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
    if (!isAutoRunning) {
      // Starting a new run, reset indices and messages
      setChatbots(prev => prev.map(cb => ({ ...cb, currentPromptIndex: 0, messages: [] })));
    }
    setIsAutoRunning(!isAutoRunning);
  };

  return (
    <div className="bg-white border border-zinc-200 rounded-xl shadow-sm flex flex-col h-[1100px] overflow-hidden">
      <div className="p-4 border-b border-zinc-100 bg-zinc-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="https://user-images.githubusercontent.com/1991296/230134379-7181e485-c521-4d23-a0d6-f7b3b61ba524.png" alt="llama.cpp" className="w-16 h-16 object-contain" referrerPolicy="no-referrer" />
          <h2 className="font-semibold text-sm text-zinc-900 truncate">{name}</h2>
          <div className="flex items-center gap-1.5 ml-auto">
            <div className={`w-2 h-2 rounded-full ${status === 'online' ? 'bg-emerald-500' : status === 'checking' ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
            <span className="text-[10px] font-semibold text-zinc-500 uppercase">{status}</span>
          </div>
        </div>
        <button
          onClick={toggleAutoRun}
          disabled={status !== 'online'}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
            isAutoRunning ? 'bg-red-50 text-red-600' : 'bg-zinc-900 text-white'
          }`}
        >
          {isAutoRunning ? 'Stop' : 'Run'}
        </button>
      </div>
      
      <div className="px-4 py-2 bg-zinc-100 text-[10px] font-mono text-zinc-600 border-b border-zinc-200">
        Aggregate Performance: {chatbots.reduce((acc, cb) => acc + cb.metrics.avgTokensPerSecond, 0).toFixed(2)} TPS
      </div>
      
      <div className="flex-1 flex flex-col gap-2 p-2 overflow-y-auto">
        {chatbots.map((cb, index) => (
          <div key={index} className="border border-zinc-100 rounded-lg flex flex-col overflow-hidden bg-zinc-50 h-[180px]">
            <div className="p-2 border-b border-zinc-100 text-[10px] font-semibold text-zinc-500 uppercase bg-zinc-100">Chatbot {index + 1}</div>
            <div className="flex flex-col flex-1 overflow-hidden">
              <div ref={el => promptRefs.current[index] = el} className="h-12 border-b border-zinc-100 overflow-y-auto p-2">
                <div className="text-[9px] font-bold text-zinc-400 uppercase mb-1">Prompts</div>
                {cb.messages.filter(m => m.role === 'user').map(msg => (
                  <div key={msg.id} className="text-xs bg-zinc-200 p-1.5 rounded mb-1">{msg.content}</div>
                ))}
              </div>
              <div ref={el => messageRefs.current[index] = el} className="flex-1 overflow-y-auto p-2">
                <div className="text-[9px] font-bold text-zinc-400 uppercase mb-1">Output</div>
                {cb.messages.filter(m => m.role === 'assistant').map(msg => (
                  <div key={msg.id} className="text-xs bg-white p-1.5 rounded border border-zinc-100 mb-1 flex flex-col gap-0.5">
                    <div>{msg.content}</div>
                    {msg.metrics && (
                      <div className="text-[8px] font-mono text-zinc-400">
                        {msg.metrics.tokensPerSecond.toFixed(2)} TPS
                      </div>
                    )}
                  </div>
                ))}
              </div>
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
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900">High-Density LLM Orchestration on Ampere CPUs</h1>
            <p className="text-zinc-500 text-sm">High-throughput inference across multi-instance compute clusters.</p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <ChatbotInstance id={1} name="1 (8080)" />
          <ChatbotInstance id={2} name="2 (8081)" />
          <ChatbotInstance id={3} name="3 (8082)" />
          <ChatbotInstance id={4} name="4 (8083)" />
        </div>
      </div>
    </div>
  );
}
