const { GoogleGenAI } = require("@google/genai");

class GeminiProvider {
  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.model = process.env.AI_MODEL || "gemini-2.5-flash";
  }

  getInfo() {
    return { name: "Gemini", model: this.model };
  }

  formatMessages(messages) {
    return messages.map((m) => {
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      };
    });
  }

  async chat(messages, systemPrompt) {
    const response = await this.ai.models.generateContent({
        model: this.model,
        contents: this.formatMessages(messages),
        config: { systemInstruction: systemPrompt }
    });
    return response.text;
  }

  async stream(messages, systemPrompt, onChunk, onDone, onError) {
    try {
      const responseStream = await this.ai.models.generateContentStream({
        model: this.model,
        contents: this.formatMessages(messages),
        config: { systemInstruction: systemPrompt }
      });
      
      for await (const chunk of responseStream) {
        if (chunk.text) {
          onChunk(chunk.text);
        }
      }
      onDone();
    } catch (error) {
      onError(error);
    }
  }
}

module.exports = GeminiProvider;
