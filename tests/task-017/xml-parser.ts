/**
 * Strict, zero-dependency XML 1.0 well-formedness parser for TASK-017 test assertions.
 * Parses XML declaration, elements, attributes, text nodes, and verifies:
 * - Valid `<?xml version="1.0" encoding="UTF-8"?>` declaration
 * - Strictly balanced opening/closing tags (exact name match)
 * - No raw unescaped `<` or `&` inside text or attribute values
 * - Single root element with no trailing junk
 */

export interface XmlNode {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  readonly text: string;
}

const ALLOWED_ENTITY_RE = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/;

function decodeXmlEntitiesStrict(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "&") {
      const semi = raw.indexOf(";", i + 1);
      if (semi === -1) {
        throw new Error(`Unescaped '&' in XML text: ${raw.slice(i, i + 20)}`);
      }
      const token = raw.slice(i, semi + 1);
      if (!ALLOWED_ENTITY_RE.test(token)) {
        throw new Error(`Invalid XML entity reference '${token}'`);
      }
      if (token === "&amp;") out += "&";
      else if (token === "&lt;") out += "<";
      else if (token === "&gt;") out += ">";
      else if (token === "&quot;") out += '"';
      else if (token === "&apos;") out += "'";
      else if (token.startsWith("&#x")) {
        out += String.fromCodePoint(Number.parseInt(token.slice(3, -1), 16));
      } else {
        out += String.fromCodePoint(Number.parseInt(token.slice(2, -1), 10));
      }
      i = semi + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function parseAttributesStrict(rawAttrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const trimmed = rawAttrString.trim();
  if (!trimmed) return attrs;

  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i += 1;
    if (i >= trimmed.length) break;

    const nameStart = i;
    while (i < trimmed.length && /[A-Za-z0-9_.:-]/.test(trimmed[i]!)) i += 1;
    const attrName = trimmed.slice(nameStart, i);
    if (!attrName) {
      throw new Error(`Invalid attribute syntax near: ${trimmed.slice(i, i + 20)}`);
    }

    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i += 1;
    if (trimmed[i] !== "=") {
      throw new Error(`Expected '=' after attribute '${attrName}'`);
    }
    i += 1;
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i += 1;

    const quote = trimmed[i];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Expected quoted value for attribute '${attrName}'`);
    }
    i += 1;
    const valStart = i;
    const valEnd = trimmed.indexOf(quote, valStart);
    if (valEnd === -1) {
      throw new Error(`Unterminated attribute value for '${attrName}'`);
    }
    const rawVal = trimmed.slice(valStart, valEnd);
    if (rawVal.includes("<")) {
      throw new Error(`Raw '<' forbidden in attribute '${attrName}'`);
    }
    if (attrName in attrs) {
      throw new Error(`Duplicate XML attribute '${attrName}'`);
    }
    attrs[attrName] = decodeXmlEntitiesStrict(rawVal);
    i = valEnd + 1;
  }

  return attrs;
}

export function parseStrictXml(xml: string): XmlNode {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
    throw new Error("XML document must begin with UTF-8 XML declaration");
  }

  // Reject ASCII control characters illegal in XML 1.0 (except \t, \n, \r)
  for (let i = 0; i < xml.length; i += 1) {
    const code = xml.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      throw new Error(`Illegal XML 1.0 control character 0x${code.toString(16)} at index ${i}`);
    }
  }

  let cursor = xml.indexOf("?>") + 2;
  const stack: Array<{
    name: string;
    attributes: Record<string, string>;
    children: XmlNode[];
    textParts: string[];
  }> = [];
  let root: XmlNode | null = null;

  while (cursor < xml.length) {
    const lt = xml.indexOf("<", cursor);
    if (lt === -1) {
      const trailing = xml.slice(cursor).trim();
      if (trailing.length > 0) {
        throw new Error(`Unexpected trailing text outside root element: ${trailing}`);
      }
      break;
    }

    if (lt > cursor) {
      const rawText = xml.slice(cursor, lt);
      const decoded = decodeXmlEntitiesStrict(rawText);
      const top = stack[stack.length - 1];
      if (!top) {
        if (decoded.trim().length > 0) {
          throw new Error(`Unexpected text outside root element: ${decoded.trim()}`);
        }
      } else {
        top.textParts.push(decoded);
      }
    }

    const gt = xml.indexOf(">", lt + 1);
    if (gt === -1) {
      throw new Error(`Unclosed '<' tag near index ${lt}`);
    }

    const tagContent = xml.slice(lt + 1, gt);
    if (tagContent.includes("<")) {
      throw new Error(`Unescaped '<' inside tag near: <${tagContent}`);
    }

    if (tagContent.startsWith("/")) {
      const closeName = tagContent.slice(1).trim();
      const popped = stack.pop();
      if (!popped || popped.name !== closeName) {
        throw new Error(
          `Mismatched closing tag </${closeName}> (expected </${popped?.name ?? "NONE"}>)`,
        );
      }
      const completed: XmlNode = {
        name: popped.name,
        attributes: popped.attributes,
        children: popped.children,
        text: popped.textParts.join("").trim(),
      };
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(completed);
      } else {
        if (root !== null) {
          throw new Error("Multiple root elements found in XML document");
        }
        root = completed;
      }
    } else {
      const selfClosing = tagContent.endsWith("/");
      const inner = (selfClosing ? tagContent.slice(0, -1) : tagContent).trim();
      const firstWs = inner.search(/\s/);
      const tagName = firstWs === -1 ? inner : inner.slice(0, firstWs);
      const rawAttrs = firstWs === -1 ? "" : inner.slice(firstWs + 1);

      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(tagName)) {
        throw new Error(`Invalid XML tag name '${tagName}'`);
      }

      const attributes = parseAttributesStrict(rawAttrs);

      if (selfClosing) {
        const leaf: XmlNode = {
          name: tagName,
          attributes,
          children: [],
          text: "",
        };
        const parent = stack[stack.length - 1];
        if (parent) {
          parent.children.push(leaf);
        } else {
          if (root !== null) {
            throw new Error("Multiple root elements found in XML document");
          }
          root = leaf;
        }
      } else {
        stack.push({
          name: tagName,
          attributes,
          children: [],
          textParts: [],
        });
      }
    }

    cursor = gt + 1;
  }

  if (stack.length > 0) {
    throw new Error(`Unclosed XML element <${stack[stack.length - 1]!.name}>`);
  }
  if (!root) {
    throw new Error("Empty XML document");
  }
  return root;
}

export function getChildElements(node: XmlNode, name: string): readonly XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

export function getFirstChildText(node: XmlNode, name: string): string | null {
  const child = node.children.find((c) => c.name === name);
  return child ? child.text : null;
}
