// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,

// =============================================================================
// GRAPH - WHERE A FAILED STATEMENT WENT WRONG (pure)
// =============================================================================
//
// Reads the line and column out of a database's error text, so the editor can
// mark the place. Not read yet: every text answers null, and nothing is marked.
// =============================================================================

import type { GraphDialect } from '../cypher/quote';

/**
 * The position a database's error text names, within the failed statement.
 *
 * @param _text - The database's text.
 * @param _dialect - The engine that wrote it, or null when not known.
 * @returns One-based line and column, or null when the text names none.
 */
export function failurePosition(_text: string, _dialect: GraphDialect | null): { line: number; column: number } | null {
	return null;
}
