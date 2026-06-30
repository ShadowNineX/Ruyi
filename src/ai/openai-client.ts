import OpenAI from 'openai';
import { env } from '../env';
import {
  getOpenAIClient,
  setOpenAIClient,
} from '../stores';

export function getSharedOpenAIClient(): OpenAI {
  const existing = getOpenAIClient();
  if (existing) { return existing; }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  setOpenAIClient(client);
  return client;
}
