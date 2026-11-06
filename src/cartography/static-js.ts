import type * as TS from 'typescript';
import type { TypeScriptModule } from '../static-analysis/typescript-loader.js';

/**
 * UNE ÉVALUATION STATIQUE D'UN FICHIER JAVASCRIPT DE CONFIGURATION (proxy.conf.js…) par son arbre syntaxique,
 * sans jamais l'exécuter : littéraux, objets, tableaux, constantes du fichier, gabarits dont toutes les
 * parties sont connues, et la forme `(p) => p.replace(/regex/, 'texte')`. Tout le reste (process.env, appel,
 * import, fonction quelconque) reste DYNAMIQUE, avec le texte de l'expression.
 */
export type JsValue =
  | string
  | number
  | boolean
  | null
  | JsValue[]
  | { [key: string]: JsValue }
  | { readonly dynamic: string }
  | { readonly rewrite: { pattern: string; replacement: string } };

export const isDynamic = (v: JsValue | undefined): v is { readonly dynamic: string } =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  typeof (v as { dynamic?: unknown }).dynamic === 'string';
export const isRewrite = (
  v: JsValue | undefined,
): v is { readonly rewrite: { pattern: string; replacement: string } } =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  typeof (v as { rewrite?: unknown }).rewrite === 'object';

/** La valeur exportée par le fichier (`module.exports = …`, `export default …`), évaluée statiquement. */
export function staticExport(ts: TypeScriptModule, file: string, text: string): JsValue | undefined {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const consts = new Map<string, TS.Expression>();
  let exported: TS.Expression | undefined;
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
    if (ts.isExportAssignment(st)) exported = st.expression;
    if (
      ts.isExpressionStatement(st) &&
      ts.isBinaryExpression(st.expression) &&
      st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      st.expression.left.getText(sf) === 'module.exports'
    )
      exported = st.expression.right;
  }
  if (!exported) return undefined;
  const evaluate = (e: TS.Expression, depth: number): JsValue => {
    const text = e.getText(sf).slice(0, 160);
    if (depth > 12) return { dynamic: text };
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))
      return evaluate(e.expression, depth + 1);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (e.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(e)) {
      const init = consts.get(e.text);
      return init ? evaluate(init, depth + 1) : { dynamic: text };
    }
    if (ts.isTemplateExpression(e)) {
      let out = e.head.text;
      for (const span of e.templateSpans) {
        const v = evaluate(span.expression, depth + 1);
        if (typeof v !== 'string' && typeof v !== 'number') return { dynamic: text };
        out += String(v) + span.literal.text;
      }
      return out;
    }
    if (ts.isArrayLiteralExpression(e)) return e.elements.map((x) => evaluate(x, depth + 1));
    if (ts.isObjectLiteralExpression(e)) {
      const out: Record<string, JsValue> = {};
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p)) {
          const key = ts.isComputedPropertyName(p.name)
            ? undefined
            : p.name.getText(sf).replace(/^['"`]|['"`]$/g, '');
          if (key !== undefined) out[key] = evaluate(p.initializer, depth + 1);
        } else if (ts.isShorthandPropertyAssignment(p)) out[p.name.text] = evaluate(p.name, depth + 1);
        else if (ts.isMethodDeclaration(p) && !ts.isComputedPropertyName(p.name))
          out[p.name.getText(sf)] = { dynamic: `fonction ${p.name.getText(sf)}()` };
        else if (ts.isSpreadAssignment(p)) {
          const inner = evaluate(p.expression, depth + 1);
          if (
            typeof inner === 'object' &&
            inner !== null &&
            !Array.isArray(inner) &&
            !isDynamic(inner) &&
            !isRewrite(inner)
          )
            Object.assign(out, inner);
          else out['…'] = { dynamic: p.getText(sf) };
        }
      }
      return out;
    }
    // `(p) => p.replace(/^\/api/, '')` : la seule fonction interprétée (une réécriture de chemin).
    if ((ts.isArrowFunction(e) || ts.isFunctionExpression(e)) && e.parameters.length >= 1) {
      const param = e.parameters[0]?.name.getText(sf);
      let body: TS.Node | undefined = e.body;
      if (ts.isBlock(body) && body.statements.length === 1) {
        const only = body.statements[0];
        body = only && ts.isReturnStatement(only) ? only.expression : undefined;
      }
      if (
        body &&
        ts.isCallExpression(body) &&
        ts.isPropertyAccessExpression(body.expression) &&
        body.expression.name.text === 'replace' &&
        body.expression.expression.getText(sf) === param &&
        body.arguments.length === 2
      ) {
        const [re, by] = body.arguments;
        const replacement = by ? evaluate(by, depth + 1) : undefined;
        if (re && ts.isRegularExpressionLiteral(re) && typeof replacement === 'string') {
          const pattern = re.text.slice(1, re.text.lastIndexOf('/'));
          return { rewrite: { pattern, replacement } };
        }
      }
      return { dynamic: `fonction ${text}` };
    }
    return { dynamic: text };
  };
  return evaluate(exported, 0);
}
