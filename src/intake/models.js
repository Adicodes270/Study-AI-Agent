// src/intake/models.js
import { z } from "zod";

export const Chapter = z.object({
  number: z.number().int(),
  title: z.string(),
  is_ncert: z.boolean().optional().default(false),
  ncert_book_code: z.string().nullable().optional().default(null),
  ncert_chapter_number: z.number().int().nullable().optional().default(null),
  pdf_url: z.string().nullable().optional().default(null),
  recommended_questions: z.number().int().nullable().optional().default(null),
});

export const Subject = z.object({
  name: z.string(),
  chapters: z.array(Chapter),
});

export const Syllabus = z.object({
  class_level: z.number().int().nullable().optional().default(null),
  exam: z.string().nullable().optional().default(null),
  subjects: z.array(Subject),
});