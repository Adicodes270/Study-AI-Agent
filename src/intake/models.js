import { z } from "zod";

export const Chapter = z.object({
  number: z.number().int(),
  title: z.string(),
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
