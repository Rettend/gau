import { docsCollection } from '@cloudflare/nimbus-docs/content'
import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'

export const collections = {
  docs: defineCollection(
    docsCollection({
      schemaFields: {
        audience: z.literal('human').optional(),
      },
    }),
  ),
}
