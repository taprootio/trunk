// Generated from shared/free-form-columns.ts by scripts/sync-field-validation.mjs. Do not edit.
import registry from "./free-form-section-registry.json" with { type: "json" };
export const COLUMNS_LIMITS = Object.freeze({ ...registry.columns.limits });
const rowType = registry.columns.nodeType;
const regionType = registry.column.nodeType;
const sectionType = registry.section.nodeType;
const excludedTypes = new Set(registry.column.excludedNodeTypes);
const maximumPathLength = 256;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const structural = (node) => node.type === rowType || node.type === regionType;
const content = (node) => Array.isArray(node.content) ? node.content : [];
const childPath = (path, index) => `${path}.content[${index}]`.slice(0, maximumPathLength);
const error = (code, path) => ({ code, field: "Body", path });
/** Follow document children, never component data, attributes or marks. Cache only immutable nodes. */
export function containsColumns(body, cache) {
    if (!object(body))
        return false;
    const seen = new WeakSet();
    const stack = [{ node: body, index: -1 }];
    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.index === -1) {
            const known = cache?.get(frame.node);
            if (known === true || structural(frame.node)) {
                for (const ancestor of stack)
                    cache?.set(ancestor.node, true);
                return true;
            }
            if (known === false || seen.has(frame.node)) {
                stack.pop();
                continue;
            }
            seen.add(frame.node);
            frame.index = 0;
        }
        const children = content(frame.node);
        if (frame.index === children.length) {
            cache?.set(frame.node, false);
            stack.pop();
            continue;
        }
        const child = children[frame.index++];
        if (object(child))
            stack.push({ node: child, index: -1 });
    }
    return false;
}
/** Existing flow placement is authoritative; adopted fragments remain root-only. */
export function isColumnEligibleBlock(value) {
    if (!object(value) || typeof value.type !== "string" || excludedTypes.has(value.type))
        return false;
    if (value.type === "componentBlock") {
        const target = object(value.attrs) ? value.attrs.componentType : undefined;
        return typeof target === "string" && Object.prototype.hasOwnProperty.call(registry.components, target)
            && registry.components[target].rootPlacement
                === registry.column.eligibleComponentRootPlacement;
    }
    return Object.prototype.hasOwnProperty.call(registry.rootNodes, value.type)
        && registry.rootNodes[value.type].placement
            === registry.column.eligibleRootNodePlacement;
}
function readAttributes(node) {
    if (node.attrs !== undefined && !object(node.attrs))
        return undefined;
    const attrs = object(node.attrs) ? node.attrs : {};
    if (Object.keys(attrs).some(key => !Object.prototype.hasOwnProperty.call(registry.columns.attrs, key))) {
        return undefined;
    }
    const count = attrs.count === undefined ? registry.columns.attrs.count.default : attrs.count;
    const ratio = attrs.ratio === undefined ? registry.columns.attrs.ratio.default : attrs.ratio;
    if (typeof count !== "number" || !Number.isInteger(count) || !registry.columns.attrs.count.values.includes(count)) {
        return undefined;
    }
    if (typeof ratio !== "string" || !registry.columns.attrs.ratio.values.includes(ratio))
        return undefined;
    if (count === 3 && ratio !== registry.columns.threeColumnRatio)
        return undefined;
    return { count: count, ratio: ratio };
}
/** Use after structural validation; omission and explicit defaults have identical meaning. */
export function columnsAttributes(node) {
    return object(node) && node.type === rowType ? readAttributes(node) : undefined;
}
function closed(node, definition) {
    return Object.keys(node).every(key => definition.nodeKeys.includes(key))
        && definition.requiredNodeKeys.every(key => Object.prototype.hasOwnProperty.call(node, key));
}
/** Cursor frames keep memory proportional to depth, including very wide old documents. */
function* semanticNodes(body) {
    const stack = [{
            node: body,
            path: "Body",
            depth: 0,
            insideRegion: false,
            index: -1,
        }];
    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.index === -1) {
            frame.index = 0;
            yield frame;
        }
        const children = content(frame.node);
        if (frame.index === children.length) {
            stack.pop();
            continue;
        }
        const index = frame.index++;
        const child = children[index];
        if (object(child)) {
            stack.push({
                node: child,
                path: childPath(frame.path, index),
                depth: frame.depth + 1,
                parentType: frame.node.type,
                insideRegion: frame.insideRegion || frame.node.type === regionType,
                index: -1,
            });
        }
    }
}
function* containers(value) {
    if (Array.isArray(value)) {
        for (const child of value)
            if (child !== null && typeof child === "object")
                yield child;
    }
    else {
        for (const key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key))
                continue;
            const child = value[key];
            if (child !== null && typeof child === "object")
                yield child;
        }
    }
}
function containerDepthExceeded(body) {
    const stack = [containers(body)];
    while (stack.length > 0) {
        const next = stack[stack.length - 1].next();
        if (next.done)
            stack.pop();
        else {
            if (stack.length === COLUMNS_LIMITS.jsonContainerDepth)
                return true;
            stack.push(containers(next.value));
        }
    }
    return false;
}
/** Validate only the new structural contract. Existing body/content policies retain their ownership. */
export function validateColumnsBody(body, options = {}) {
    if (!containsColumns(body, options.presenceCache))
        return { hasColumns: false, errors: [] };
    const refuse = (code, path = "Body") => ({
        hasColumns: true,
        errors: [error(code, path)],
    });
    if (options.allowColumns === false)
        return refuse("columns.not_allowed");
    if (!object(body) || body.type !== "doc" || !Array.isArray(body.content))
        return refuse("columns.document");
    let nodes = 0;
    for (const visit of semanticNodes(body)) {
        const { node, path, depth, parentType, insideRegion } = visit;
        if (++nodes > COLUMNS_LIMITS.nodesPerDocument)
            return refuse("columns.node_count", path);
        if (depth > COLUMNS_LIMITS.nodeDepth)
            return refuse("columns.node_depth", path);
        if (insideRegion && (typeof node.type === "string" && excludedTypes.has(node.type)
            || node.type === "componentBlock" && !isColumnEligibleBlock(node))) {
            return refuse("columns.region_block", path);
        }
        if (node.type === rowType) {
            if (depth !== 2 || parentType !== sectionType)
                return refuse("columns.placement", path);
            if (!closed(node, registry.columns) || !Array.isArray(node.content))
                return refuse("columns.shape", path);
            const attrs = readAttributes(node);
            if (!attrs)
                return refuse("columns.attributes", path);
            if (node.content.length !== attrs.count || node.content.some(child => !object(child) || child.type !== regionType)) {
                return refuse("columns.regions", path);
            }
        }
        else if (node.type === regionType) {
            if (parentType !== rowType)
                return refuse("columns.region_placement", path);
            if (!closed(node, registry.column) || !Array.isArray(node.content))
                return refuse("columns.region_shape", path);
            if (node.content.length < registry.column.minimumChildren || node.content.length > COLUMNS_LIMITS.blocksPerRegion) {
                return refuse("columns.region_blocks", path);
            }
            const invalid = node.content.findIndex(child => !isColumnEligibleBlock(child));
            if (invalid !== -1)
                return refuse("columns.region_block", childPath(path, invalid));
        }
        else if (node.type === sectionType && depth === 1) {
            const children = content(node);
            if (children.length > COLUMNS_LIMITS.nodesPerDocument - nodes)
                return refuse("columns.node_count", path);
            let rows = 0;
            let invalid = -1;
            for (let index = 0; index < children.length; index++) {
                const child = children[index];
                if (object(child) && child.type === rowType)
                    rows++;
                else if (invalid === -1 && !isColumnEligibleBlock(child))
                    invalid = index;
            }
            if (rows > COLUMNS_LIMITS.rowsPerSection)
                return refuse("columns.section_rows", path);
            if (invalid !== -1)
                return refuse("columns.section_block", childPath(path, invalid));
        }
    }
    // Count attribute/config containers too, without serializing text or imposing a byte quota.
    if (containerDepthExceeded(body))
        return refuse("columns.container_depth");
    return { hasColumns: true, errors: [] };
}
/** Validate once, then path-copy only nodes changed by structural default omission. */
export function normalizeColumnsBody(body, options = {}) {
    const result = validateColumnsBody(body, options);
    if (!result.hasColumns || result.errors.length > 0)
        return { ...result, body };
    const rewrite = (node) => {
        const children = content(node);
        const rewritten = children.map(child => object(child) ? rewrite(child) : child);
        const changedChildren = rewritten.some((child, index) => child !== children[index]);
        let copy = changedChildren ? { ...node, content: rewritten } : node;
        if (node.type === rowType && object(node.attrs)) {
            const attrs = { ...node.attrs };
            if (attrs.count === registry.columns.attrs.count.default)
                delete attrs.count;
            if (attrs.ratio === registry.columns.attrs.ratio.default)
                delete attrs.ratio;
            if (Object.keys(attrs).length !== Object.keys(node.attrs).length || Object.keys(attrs).length === 0) {
                copy = { ...copy };
                if (Object.keys(attrs).length === 0)
                    delete copy.attrs;
                else
                    copy.attrs = attrs;
            }
        }
        return copy;
    };
    return { ...result, body: rewrite(body) };
}
