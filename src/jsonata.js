/**
 * © Copyright IBM Corp. 2016, 2017 All Rights Reserved
 *   Project name: JSONata
 *   This project is licensed under the MIT License, see LICENSE
 */

/**
 * @module JSONata
 * @description JSON query and transformation language
 */

var datetime = require('./datetime');
var fn = require('./functions');
var utils = require('./utils');
var parser = require('./parser');
var parseSignature = require('./signature');

/**
 * jsonata
 * @function
 * @param {Object} expr - JSONata expression
 * @returns {{evaluate: evaluate, assign: assign}} Evaluated expression
 */
var jsonata = (function() {
    'use strict';

    var isNumeric = utils.isNumeric;
    var isArrayOfStrings = utils.isArrayOfStrings;
    var isArrayOfNumbers = utils.isArrayOfNumbers;
    var createSequence = utils.createSequence;
    var isSequence = utils.isSequence;
    var isFunction = utils.isFunction;
    var isLambda = utils.isLambda;
    var isIterable = utils.isIterable;
    var isPromise = utils.isPromise;
    var getFunctionArity = utils.getFunctionArity;
    var isDeepEqual = utils.isDeepEqual;

    // Start of Evaluator code

    var staticFrame = createFrame(null);

    /**
     * Evaluate expression against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    async function evaluate(expr, input, environment) {
        var result;

        var entryCallback = environment.lookup(Symbol.for('jsonata.__evaluate_entry'));
        if(entryCallback) {
            await entryCallback(expr, input, environment);
        }

        switch (expr.type) {
            case 'path':
                result = await evaluatePath(expr, input, environment);
                break;
            case 'binary':
                result = await evaluateBinary(expr, input, environment);
                break;
            case 'unary':
                result = await evaluateUnary(expr, input, environment);
                break;
            case 'name':
                result = evaluateName(expr, input, environment);
                break;
            case 'string':
            case 'number':
            case 'value':
                result = evaluateLiteral(expr, input, environment);
                break;
            case 'wildcard':
                result = evaluateWildcard(expr, input, environment);
                break;
            case 'descendant':
                result = evaluateDescendants(expr, input, environment);
                break;
            case 'parent':
                result = environment.lookup(expr.slot.label);
                break;
            case 'condition':
                result = await evaluateCondition(expr, input, environment);
                break;
            case 'block':
                result = await evaluateBlock(expr, input, environment);
                break;
            case 'bind':
                result = await evaluateBindExpression(expr, input, environment);
                break;
            case 'regex':
                result = evaluateRegex(expr, input, environment);
                break;
            case 'function':
                result = await evaluateFunction(expr, input, environment);
                break;
            case 'variable':
                result = evaluateVariable(expr, input, environment);
                break;
            case 'lambda':
                result = evaluateLambda(expr, input, environment);
                break;
            case 'partial':
                result = await evaluatePartialApplication(expr, input, environment);
                break;
            case 'apply':
                result = await evaluateApplyExpression(expr, input, environment);
                break;
            case 'transform':
                result = evaluateTransformExpression(expr, input, environment);
                break;
        }

        if (Object.prototype.hasOwnProperty.call(expr, 'predicate')) {
            for(var ii = 0; ii < expr.predicate.length; ii++) {
                result = await evaluateFilter(expr.predicate[ii].expr, result, environment);
            }
        }

        if (expr.type !== 'path' && Object.prototype.hasOwnProperty.call(expr, 'group')) {
            result = await evaluateGroupExpression(expr.group, result, environment);
        }

        var exitCallback = environment.lookup(Symbol.for('jsonata.__evaluate_exit'));
        if(exitCallback) {
            await exitCallback(expr, input, environment, result);
        }

        if(result && isSequence(result) && !result.tupleStream) {
            if(expr.keepArray) {
                result.keepSingleton = true;
            }
            if(result.length === 0) {
                result = undefined;
            } else if(result.length === 1) {
                result =  result.keepSingleton ? result : result[0];
            }

        }

        return result;
    }

    /**
     * Evaluate path expression against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    async function evaluatePath(expr, input, environment) {
        var inputSequence;
        // expr is an array of steps
        // if the first step is a variable reference ($...), including root reference ($$),
        //   then the path is absolute rather than relative
        if (Array.isArray(input) && expr.steps[0].type !== 'variable') {
            inputSequence = input;
        } else {
            // if input is not an array, make it so
            inputSequence = createSequence(input);
        }

        var resultSequence;
        var isTupleStream = false;
        var tupleBindings = undefined;

        // evaluate each step in turn
        for(var ii = 0; ii < expr.steps.length; ii++) {
            var step = expr.steps[ii];

            if(step.tuple) {
                isTupleStream = true;
            }

            // if the first step is an explicit array constructor, then just evaluate that (i.e. don't iterate over a context array)
            if(ii === 0 && step.consarray) {
                resultSequence = await evaluate(step, inputSequence, environment);
            } else {
                if(isTupleStream) {
                    tupleBindings = await evaluateTupleStep(step, inputSequence, tupleBindings, environment);
                } else {
                    resultSequence = await evaluateStep(step, inputSequence, environment, ii === expr.steps.length - 1);
                }
            }

            if (!isTupleStream && (typeof resultSequence === 'undefined' || resultSequence.length === 0)) {
                break;
            }

            if(typeof step.focus === 'undefined') {
                inputSequence = resultSequence;
            }

        }

        if(isTupleStream) {
            if(expr.tuple) {
                // tuple stream is carrying ancestry information - keep this
                resultSequence = tupleBindings;
            } else {
                resultSequence = createSequence();
                for (ii = 0; ii < tupleBindings.length; ii++) {
                    resultSequence.push(tupleBindings[ii]['@']);
                }
            }
        }

        if(expr.keepSingletonArray) {
            // if the array is explicitly constructed in the expression and marked to promote singleton sequences to array
            if(Array.isArray(resultSequence) && resultSequence.cons && !resultSequence.sequence) {
                resultSequence = createSequence(resultSequence);
            }
            resultSequence.keepSingleton = true;
        }

        if (expr.hasOwnProperty('group')) {
            resultSequence = await evaluateGroupExpression(expr.group, isTupleStream ? tupleBindings : resultSequence, environment)
        }

        return resultSequence;
    }

    function createFrameFromTuple(environment, tuple) {
        var frame = createFrame(environment);
        for(const prop in tuple) {
            frame.bind(prop, tuple[prop]);
        }
        return frame;
    }

    /**
     * Evaluate a step within a path
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @param {boolean} lastStep - flag the last step in a path
     * @returns {*} Evaluated input data
     */
    async function evaluateStep(expr, input, environment, lastStep) {
        var result;
        if(expr.type === 'sort') {
             result = await evaluateSortExpression(expr, input, environment);
             if(expr.stages) {
                 result = await evaluateStages(expr.stages, result, environment);
             }
             return result;
        }

        result = createSequence();

        for(var ii = 0; ii < input.length; ii++) {
            var res = await evaluate(expr, input[ii], environment);
            if(expr.stages) {
                for(var ss = 0; ss < expr.stages.length; ss++) {
                    res = await evaluateFilter(expr.stages[ss].expr, res, environment);
                }
            }
            if(typeof res !== 'undefined') {
                result.push(res);
            }
        }

        var resultSequence = createSequence();
        if(lastStep && result.length === 1 && Array.isArray(result[0]) && !isSequence(result[0])) {
            resultSequence = result[0];
        } else {
            // flatten the sequence
            result.forEach(function(res) {
                if (!Array.isArray(res) || res.cons) {
                    // it's not an array - just push into the result sequence
                    resultSequence.push(res);
                } else {
                    // res is a sequence - flatten it into the parent sequence
                    res.forEach(val => resultSequence.push(val));
                }
            });
        }

        return resultSequence;
    }

    async function evaluateStages(stages, input, environment) {
        var result = input;
        for(var ss = 0; ss < stages.length; ss++) {
            var stage = stages[ss];
            switch(stage.type) {
                case 'filter':
                    result = await evaluateFilter(stage.expr, result, environment);
                    break;
                case 'index':
                    for(var ee = 0; ee < result.length; ee++) {
                        var tuple = result[ee];
                        tuple[stage.value] = ee;
                    }
                    break;
            }
        }
        return result;
    }

    /**
     * Evaluate a step within a path
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} tupleBindings - The tuple stream
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    async function evaluateTupleStep(expr, input, tupleBindings, environment) {
        var result;
        if(expr.type === 'sort') {
            if(tupleBindings) {
                result = await evaluateSortExpression(expr, tupleBindings, environment);
            } else {
                var sorted = await evaluateSortExpression(expr, input, environment);
                result = createSequence();
                result.tupleStream = true;
                for(var ss = 0; ss < sorted.length; ss++) {
                    var tuple = {'@': sorted[ss]};
                    tuple[expr.index] = ss;
                    result.push(tuple);
                }
            }
            if(expr.stages) {
                result = await evaluateStages(expr.stages, result, environment);
            }
            return result;
        }

        result = createSequence();
        result.tupleStream = true;
        var stepEnv = environment;
        if(tupleBindings === undefined) {
            tupleBindings = input.map(item => { return {'@': item} });
        }

        for(var ee = 0; ee < tupleBindings.length; ee++) {
            stepEnv = createFrameFromTuple(environment, tupleBindings[ee]);
            var res = await evaluate(expr, tupleBindings[ee]['@'], stepEnv);
            // res is the binding sequence for the output tuple stream
            if(typeof res !== 'undefined') {
                if (!Array.isArray(res)) {
                    res = [res];
                }
                for (var bb = 0; bb < res.length; bb++) {
                    tuple = {};
                    Object.assign(tuple, tupleBindings[ee]);
                    if(res.tupleStream) {
                        Object.assign(tuple, res[bb]);
                    } else {
                        if (expr.focus) {
                            tuple[expr.focus] = res[bb];
                            tuple['@'] = tupleBindings[ee]['@'];
                        } else {
                            tuple['@'] = res[bb];
                        }
                        if (expr.index) {
                            tuple[expr.index] = bb;
                        }
                        if (expr.ancestor) {
                            tuple[expr.ancestor.label] = tupleBindings[ee]['@'];
                        }
                    }
                    result.push(tuple);
                }
            }
        }

        if(expr.stages) {
            result = await evaluateStages(expr.stages, result, environment);
        }

        return result;
    }

    /**
     * Apply filter predicate to input data
     * @param {Object} predicate - filter expression
     * @param {Object} input - Input data to apply predicates against
     * @param {Object} environment - Environment
     * @returns {*} Result after applying predicates
     */
    async function evaluateFilter(predicate, input, environment) {
        var results = createSequence();
        if( input && input.tupleStream) {
            results.tupleStream = true;
        }
        if (!Array.isArray(input)) {
            input = createSequence(input);
        }
        if (predicate.type === 'number') {
            var index = Math.floor(predicate.value);  // round it down
            if (index < 0) {
                // count in from end of array
                index = input.length + index;
            }
            var item = await input[index];
            if(typeof item !== 'undefined') {
                if(Array.isArray(item)) {
                    results = item;
                } else {
                    results.push(item);
                }
            }
        } else {
            for (index = 0; index < input.length; index++) {
                var item = input[index];
                var context = item;
                var env = environment;
                if(input.tupleStream) {
                    context = item['@'];
                    env = createFrameFromTuple(environment, item);
                }
                var res = await evaluate(predicate, context, env);
                if (isNumeric(res)) {
                    res = [res];
                }
                if (isArrayOfNumbers(res)) {
                    res.forEach(function (ires) {
                        // round it down
                        var ii = Math.floor(ires);
                        if (ii < 0) {
                            // count in from end of array
                            ii = input.length + ii;
                        }
                        if (ii === index) {
                            results.push(item);
                        }
                    });
                } else if (fn.boolean(res)) { // truthy
                    results.push(item);
                }
            }
        }
        return results;
    }

    /**
     * Evaluate binary expression against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    async function evaluateBinary(expr, input, environment) {
        var result;
        var lhs = await evaluate(expr.lhs, input, environment);
        var op = expr.value;

        //defer evaluation of RHS to allow short-circuiting
        var evalrhs = async () => await evaluate(expr.rhs, input, environment);
        if (op === "and" || op === "or") {
            try {
                return await evaluateBooleanExpression(lhs, evalrhs, op);
            } catch(err) {
                err.position = expr.position;
                err.token = op;
                throw err;
            }
        }

        var rhs = await evalrhs();
        try {
            switch (op) {
                case '+':
                case '-':
                case '*':
                case '/':
                case '%':
                    result = evaluateNumericExpression(lhs, rhs, op);
                    break;
                case '=':
                case '!=':
                    result = evaluateEqualityExpression(lhs, rhs, op);
                    break;
                case '<':
                case '<=':
                case '>':
                case '>=':
                    result = evaluateComparisonExpression(lhs, rhs, op);
                    break;
                case '&':
                    result = evaluateStringConcat(lhs, rhs);
                    break;
                case '..':
                    result = evaluateRangeExpression(lhs, rhs);
                    break;
                case 'in':
                    result = evaluateIncludesExpression(lhs, rhs);
                    break;
            }
        } catch(err) {
            err.position = expr.position;
            err.token = op;
            throw err;
        }
        return result;
    }

    /**
     * Evaluate unary expression against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    async function evaluateUnary(expr, input, environment) {
        var result;

        switch (expr.value) {
            case '-':
                result = await evaluate(expr.expression, input, environment);
                if(typeof result === 'undefined') {
                    result = undefined;
                } else if (isNumeric(result)) {
                    result = -result;
                } else {
                    throw {
                        code: "D1002",
                        stack: (new Error()).stack,
                        position: expr.position,
                        token: expr.value,
                        value: result
                    };
                }
                break;
            case '[':
                // array constructor - evaluate each item
                result = [];
                let generators = await Promise.all(expr.expressions
                    .map(async (item, idx) => {
                        environment.isParallelCall = idx > 0
                        return [item, await evaluate(item, input, environment)]
                    }));
                for (let generator of generators) {
                    var [item, value] = generator;
                    if (typeof value !== 'undefined') {
                        if(item.value === '[') {
                            result.push(value);
                        } else {
                            result = fn.append(result, value);
                        }
                    }
                }
                if(expr.consarray) {
                    Object.defineProperty(result, 'cons', {
                        enumerable: false,
                        configurable: false,
                        value: true
                    });
                }
                break;
            case '{':
                // object constructor - apply grouping
                result = await evaluateGroupExpression(expr, input, environment);
                break;

        }
        return result;
    }

    /**
     * Evaluate name object against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    function evaluateName(expr, input, environment) {
        // lookup the 'name' item in the input
        return fn.lookup(input, expr.value);
    }

    /**
     * Evaluate literal against input data
     * @param {Object} expr - JSONata expression
     * @returns {*} Evaluated input data
     */
    function evaluateLiteral(expr) {
        return expr.value;
    }

    /**
     * Evaluate wildcard against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @returns {*} Evaluated input data
     */
    function evaluateWildcard(expr, input) {
        var results = createSequence();
        if (Array.isArray(input) && input.outerWrapper && input.length > 0) {
            input = input[0];
        }
        if (input !== null && typeof input === 'object') {
            Object.keys(input).forEach(function (key) {
                var value = input[key];
                if(Array.isArray(value)) {
                    value = flatten(value);
                    results = fn.append(results, value);
                } else {
                    results.push(value);
                }
            });
        }

        //        result = normalizeSequence(results);
        return results;
    }

    /**
     * Returns a flattened array
     * @param {Array} arg - the array to be flatten
     * @param {Array} flattened - carries the flattened array - if not defined, will initialize to []
     * @returns {Array} - the flattened array
     */
    function flatten(arg, flattened) {
        if(typeof flattened === 'undefined') {
            flattened = [];
        }
        if(Array.isArray(arg)) {
            arg.forEach(function (item) {
                flatten(item, flattened);
            });
        } else {
            flattened.push(arg);
        }
        return flattened;
    }

    /**
     * Evaluate descendants against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @returns {*} Evaluated input data
     */
    function evaluateDescendants(expr, input) {
        var result;
        var resultSequence = createSequence();
        if (typeof input !== 'undefined') {
            // traverse all descendants of this object/array
            recurseDescendants(input, resultSequence);
            if (resultSequence.length === 1) {
                result = resultSequence[0];
            } else {
                result = resultSequence;
            }
        }
        return result;
    }

    /**
     * Recurse through descendants
     * @param {Object} input - Input data
     * @param {Object} results - Results
     */
    function recurseDescendants(input, results) {
        // this is the equivalent of //* in XPath
        if (!Array.isArray(input)) {
            results.push(input);
        }
        if (Array.isArray(input)) {
            input.forEach(function (member) {
                recurseDescendants(member, results);
            });
        } else if (input !== null && typeof input === 'object') {
            Object.keys(input).forEach(function (key) {
                recurseDescendants(input[key], results);
            });
        }
    }

    /**
     * Evaluate numeric expression against input data
     * @param {Object} lhs - LHS value
     * @param {Object} rhs - RHS value
     * @param {Object} op - opcode
     * @returns {*} Result
     */
    function evaluateNumericExpression(lhs, rhs, op) {
        var result;

        if (typeof lhs !== 'undefined' && !isNumeric(lhs)) {
            throw {
                code: "T2001",
                stack: (new Error()).stack,
                value: lhs
            };
        }
        if (typeof rhs !== 'undefined' && !isNumeric(rhs)) {
            throw {
                code: "T2002",
                stack: (new Error()).stack,
                value: rhs
            };
        }

        if (typeof lhs === 'undefined' || typeof rhs === 'undefined') {
            // if either side is undefined, the result is undefined
            return result;
        }

        switch (op) {
            case '+':
                result = lhs + rhs;
                break;
            case '-':
                result = lhs - rhs;
                break;
            case '*':
                result = lhs * rhs;
                break;
            case '/':
                result = lhs / rhs;
                break;
            case '%':
                result = lhs % rhs;
                break;
        }
        return result;
    }

    /**
     * Evaluate equality expression against input data
     * @param {Object} lhs - LHS value
     * @param {Object} rhs - RHS value
     * @param {Object} op - opcode
     * @returns {*} Result
     */
    function evaluateEqualityExpression(lhs, rhs, op) {
        var result;

        // type checks
        var ltype = typeof lhs;
        var rtype = typeof rhs;

        if (ltype === 'undefined' || rtype === 'undefined') {
            // if either side is undefined, the result is false
            return false;
        }

        switch (op) {
            case '=':
                result = isDeepEqual(lhs, rhs);
                break;
            case '!=':
                result = !isDeepEqual(lhs, rhs);
                break;
        }
        return result;
    }

    /**
     * Evaluate comparison expression against input data
     * @param {Object} lhs - LHS value
     * @param {Object} rhs - RHS value
     * @param {Object} op - opcode
     * @returns {*} Result
     */
    function evaluateComparisonExpression(lhs, rhs, op) {
        var result;

        // type checks
        var ltype = typeof lhs;
        var rtype = typeof rhs;

        var lcomparable = (ltype === 'undefined' || ltype === 'string' || ltype === 'number');
        var rcomparable = (rtype === 'undefined' || rtype === 'string' || rtype === 'number');

        // if either aa or bb are not comparable (string or numeric) values, then throw an error
        if (!lcomparable || !rcomparable) {
            throw {
                code: "T2010",
                stack: (new Error()).stack,
                value: !(ltype === 'string' || ltype === 'number') ? lhs : rhs
            };
        }

        // if either side is undefined, the result is undefined
        if (ltype === 'undefined' || rtype === 'undefined') {
            return undefined;
        }

        //if aa and bb are not of the same type
        if (ltype !== rtype) {
            throw {
                code: "T2009",
                stack: (new Error()).stack,
                value: lhs,
                value2: rhs
            };
        }

        switch (op) {
            case '<':
                result = lhs < rhs;
                break;
            case '<=':
                result = lhs <= rhs;
                break;
            case '>':
                result = lhs > rhs;
                break;
            case '>=':
                result = lhs >= rhs;
                break;
        }
        return result;
    }

    /**
     * Inclusion operator - in
     *
     * @param {Object} lhs - LHS value
     * @param {Object} rhs - RHS value
     * @returns {boolean} - true if lhs is a member of rhs
     */
    function evaluateIncludesExpression(lhs, rhs) {
        var result = false;

        if (typeof lhs === 'undefined' || typeof rhs === 'undefined') {
            // if either side is undefined, the result is false
            return false;
        }

        if(!Array.isArray(rhs)) {
            rhs = [rhs];
        }

        for(var i = 0; i < rhs.length; i++) {
            if(rhs[i] === lhs) {
                result = true;
                break;
            }
        }

        return result;
    }

    /**
     * Evaluate boolean expression against input data
     * @param {Object} lhs - LHS value
     * @param {Function} evalrhs - function to evaluate RHS value
     * @param {Object} op - opcode
     * @returns {*} Result
     */
    async function evaluateBooleanExpression(lhs, evalrhs, op) {
        var result;

        var lBool = boolize(lhs);

        switch (op) {
            case 'and':
                result = lBool && boolize(await evalrhs());
                break;
            case 'or':
                result = lBool || boolize(await evalrhs());
                break;
        }
        return result;
    }

    function boolize(value) {
        var booledValue = fn.boolean(value);
        return typeof booledValue === 'undefined' ? false : booledValue;
    }

    /**
     * Evaluate string concatenation against input data
     * @param {Object} lhs - LHS value
     * @param {Object} rhs - RHS value
     * @returns {string|*} Concatenated string
     */
    function evaluateStringConcat(lhs, rhs) {
        var result;

        var lstr = '';
        var rstr = '';
        if (typeof lhs !== 'undefined') {
            lstr = fn.string(lhs);
        }
        if (typeof rhs !== 'undefined') {
            rstr = fn.string(rhs);
        }

        result = lstr.concat(rstr);
        return result;
    }

    /**
     * Evaluate group expression against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {{}} Evaluated input data
     */
    async function evaluateGroupExpression(expr, input, environment) {
        var result = {};
        var groups = {};
        var reduce = input && input.tupleStream ? true : false;
        // group the input sequence by 'key' expression
        if (!Array.isArray(input)) {
            input = createSequence(input);
        }
        // if the array is empty, add an undefined entry to enable literal JSON object to be generated
        if (input.length === 0) {
            input.push(undefined);
        }

        for(var itemIndex = 0; itemIndex < input.length; itemIndex++) {
            var item = input[itemIndex];
            var env = reduce ? createFrameFromTuple(environment, item) : environment;
            for(var pairIndex = 0; pairIndex < expr.lhs.length; pairIndex++) {
                var pair = expr.lhs[pairIndex];
                var key = await evaluate(pair[0], reduce ? item['@'] : item, env);
                // key has to be a string
                if (typeof  key !== 'string' && key !== undefined) {
                    throw {
                        code: "T1003",
                        stack: (new Error()).stack,
                        position: expr.position,
                        value: key
                    };
                }

                if (key !== undefined) {
                    var entry = {data: item, exprIndex: pairIndex};
                    if (groups.hasOwnProperty(key)) {
                        // a value already exists in this slot
                        if(groups[key].exprIndex !== pairIndex) {
                            // this key has been generated by another expression in this group
                            // when multiple key expressions evaluate to the same key, then error D1009 must be thrown
                            throw {
                                code: "D1009",
                                stack: (new Error()).stack,
                                position: expr.position,
                                value: key
                            };
                        }

                        // append it as an array
                        groups[key].data = fn.append(groups[key].data, item);
                    } else {
                        groups[key] = entry;
                    }
                }
            }
        }

        // iterate over the groups to evaluate the 'value' expression
        let generators = await Promise.all(Object.keys(groups).map(async (key, idx) => {
            let entry = groups[key];
            var context = entry.data;
            var env = environment;
            if (reduce) {
                var tuple = reduceTupleStream(entry.data);
                context = tuple['@'];
                delete tuple['@'];
                env = createFrameFromTuple(environment, tuple);
            }
            environment.isParallelCall = idx > 0
            return [key, await evaluate(expr.lhs[entry.exprIndex][1], context, env)];
        }));

        for (let generator of generators) {
            var [key, value] = await generator;
            if(typeof value !== 'undefined') {
                result[key] = value;
            }
        }

        return result;
    }

    function reduceTupleStream(tupleStream) {
        if(!Array.isArray(tupleStream)) {
            return tupleStream;
        }
        var result = {};
        Object.assign(result, tupleStream[0]);
        for(var ii = 1; ii < tupleStream.length; ii++) {
            for(const prop in tupleStream[ii]) {
                result[prop] = fn.append(result[prop], tupleStream[ii][prop]);
            }
        }
        return result;
    }

    /**
     * Evaluate range expression against input data
     * @param {Object} lhs - LHS value
     * @param {Object} rhs - RHS value
     * @returns {Array} Resultant array
     */
    function evaluateRangeExpression(lhs, rhs) {
        var result;

        if (typeof lhs !== 'undefined' && !Number.isInteger(lhs)) {
            throw {
                code: "T2003",
                stack: (new Error()).stack,
                value: lhs
            };
        }
        if (typeof rhs !== 'undefined' && !Number.isInteger(rhs)) {
            throw {
                code: "T2004",
                stack: (new Error()).stack,
                value: rhs
            };
        }

        if (typeof lhs === 'undefined' || typeof rhs === 'undefined') {
            // if either side is undefined, the result is undefined
            return result;
        }

        if (lhs > rhs) {
            // if the lhs is greater than the rhs, return undefined
            return result;
        }

        // limit the size of the array to ten million entries (1e7)
        // this is an implementation defined limit to protect against
        // memory and performance issues.  This value may increase in the future.
        var size = rhs - lhs + 1;
        if(size > 1e7) {
            throw {
                code: "D2014",
                stack: (new Error()).stack,
                value: size
            };
        }

        result = new Array(size);
        for (var item = lhs, index = 0; item <= rhs; item++, index++) {
            result[index] = item;
        }
        result.sequence = true;
        return result;
    }

    /**
     * Evaluate bind expression against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    async function evaluateBindExpression(expr, input, environment) {
        // The RHS is the expression to evaluate
        // The LHS is the name of the variable to bind to - should be a VARIABLE token (enforced by parser)
        var value = await evaluate(expr.rhs, input, environment);
        environment.bind(expr.lhs.value, value);
        return value;
    }

    /**
     * Evaluate condition against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    async function evaluateCondition(expr, input, environment) {
        var result;
        var condition = await evaluate(expr.condition, input, environment);
        if (fn.boolean(condition)) {
            result = await evaluate(expr.then, input, environment);
        } else if (typeof expr.else !== 'undefined') {
            result = await evaluate(expr.else, input, environment);
        }
        return result;
    }

    /**
     * Evaluate block against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    async function evaluateBlock(expr, input, environment) {
        var result;
        // create a new frame to limit the scope of variable assignments
        // TODO, only do this if the post-parse stage has flagged this as required
        var frame = createFrame(environment);
        // invoke each expression in turn
        // only return the result of the last one
        for(var ii = 0; ii < expr.expressions.length; ii++) {
            result = await evaluate(expr.expressions[ii], input, frame);
        }

        return result;
    }

    /**
     * Prepare a regex
     * @param {Object} expr - expression containing regex
     * @returns {Function} Higher order function representing prepared regex
     */
    function evaluateRegex(expr) {
        var re = new jsonata.RegexEngine(expr.value);
        var closure = function(str, fromIndex) {
            var result;
            re.lastIndex = fromIndex || 0;
            var match = re.exec(str);
            if(match !== null) {
                result = {
                    match: match[0],
                    start: match.index,
                    end: match.index + match[0].length,
                    groups: []
                };
                if(match.length > 1) {
                    for(var i = 1; i < match.length; i++) {
                        result.groups.push(match[i]);
                    }
                }
                result.next = function() {
                    if(re.lastIndex >= str.length) {
                        return undefined;
                    } else {
                        var next = closure(str, re.lastIndex);
                        if(next && next.match === '') {
                            // matches zero length string; this will never progress
                            throw {
                                code: "D1004",
                                stack: (new Error()).stack,
                                position: expr.position,
                                value: expr.value.source
                            };
                        }
                        return next;
                    }
                };
            }

            return result;
        };
        return closure;
    }

    /**
     * Evaluate variable against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    function evaluateVariable(expr, input, environment) {
        // lookup the variable value in the environment
        var result;
        // if the variable name is empty string, then it refers to context value
        if (expr.value === '') {
            result = input && input.outerWrapper ? input[0] : input;
        } else {
            result = environment.lookup(expr.value);
        }
        return result;
    }

    /**
     * sort / order-by operator
     * @param {Object} expr - AST for operator
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Ordered sequence
     */
    async function evaluateSortExpression(expr, input, environment) {
        var result;

        // evaluate the lhs, then sort the results in order according to rhs expression
        var lhs = input;
        var isTupleSort = input.tupleStream ? true : false;

        // sort the lhs array
        // use comparator function
        var comparator = async function(a, b) { 
            // expr.terms is an array of order-by in priority order
            var comp = 0;
            for(var index = 0; comp === 0 && index < expr.terms.length; index++) {
                var term = expr.terms[index];
                //evaluate the sort term in the context of a
                var context = a;
                var env = environment;
                if(isTupleSort) {
                    context = a['@'];
                    env = createFrameFromTuple(environment, a);
                }
                var aa = await evaluate(term.expression, context, env);
                //evaluate the sort term in the context of b
                context = b;
                env = environment;
                if(isTupleSort) {
                    context = b['@'];
                    env = createFrameFromTuple(environment, b);
                }
                var bb = await evaluate(term.expression, context, env);

                // type checks
                var atype = typeof aa;
                var btype = typeof bb;
                // undefined should be last in sort order
                if(atype === 'undefined') {
                    // swap them, unless btype is also undefined
                    comp = (btype === 'undefined') ? 0 : 1;
                    continue;
                }
                if(btype === 'undefined') {
                    comp = -1;
                    continue;
                }

                // if aa or bb are not string or numeric values, then throw an error
                if(!(atype === 'string' || atype === 'number') || !(btype === 'string' || btype === 'number')) {
                    throw {
                        code: "T2008",
                        stack: (new Error()).stack,
                        position: expr.position,
                        value: !(atype === 'string' || atype === 'number') ? aa : bb
                    };
                }

                //if aa and bb are not of the same type
                if(atype !== btype) {
                    throw {
                        code: "T2007",
                        stack: (new Error()).stack,
                        position: expr.position,
                        value: aa,
                        value2: bb
                    };
                }
                if(aa === bb) {
                    // both the same - move on to next term
                    continue;
                } else if (aa < bb) {
                    comp = -1;
                } else {
                    comp = 1;
                }
                if(term.descending === true) {
                    comp = -comp;
                }
            }
            // only swap a & b if comp equals 1
            return comp === 1;
        };

        var focus = {
            environment: environment,
            input: input
        };
        // the `focus` is passed in as the `this` for the invoked function
        result = await fn.sort.apply(focus, [lhs, comparator]);

        return result;
    }

    /**
     * create a transformer function
     * @param {Object} expr - AST for operator
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} tranformer function
     */
    function evaluateTransformExpression(expr, input, environment) {
        // create a function to implement the transform definition
        var transformer = async function (obj) { // signature <(oa):o>
            // undefined inputs always return undefined
            if(typeof obj === 'undefined') {
                return undefined;
            }

            // this function returns a copy of obj with changes specified by the pattern/operation
            var cloneFunction = environment.lookup('clone');
            if(!isFunction(cloneFunction)) {
                // throw type error
                throw {
                    code: "T2013",
                    stack: (new Error()).stack,
                    position: expr.position
                };
            }
            var result = await apply(cloneFunction, [obj], null, environment);
            var matches = await evaluate(expr.pattern, result, environment);
            if(typeof matches !== 'undefined') {
                if(!Array.isArray(matches)) {
                    matches = [matches];
                }
                for(var ii = 0; ii < matches.length; ii++) {
                    var match = matches[ii];
                    if (match && (match.isPrototypeOf(result) || match instanceof Object.constructor)) {
                        throw {
                            code: "D1010",
                            stack: (new Error()).stack,
                            position: expr.position
                        };
                    }
                    // evaluate the update value for each match
                    var update = await evaluate(expr.update, match, environment);
                    // update must be an object
                    var updateType = typeof update;
                    if(updateType !== 'undefined') {
                        if(updateType !== 'object' || update === null || Array.isArray(update)) {
                            // throw type error
                            throw {
                                code: "T2011",
                                stack: (new Error()).stack,
                                position: expr.update.position,
                                value: update
                            };
                        }
                        // merge the update
                        for(var prop in update) {
                            match[prop] = update[prop];
                        }
                    }

                    // delete, if specified, must be an array of strings (or single string)
                    if(typeof expr.delete !== 'undefined') {
                        var deletions = await evaluate(expr.delete, match, environment);
                        if(typeof deletions !== 'undefined') {
                            var val = deletions;
                            if (!Array.isArray(deletions)) {
                                deletions = [deletions];
                            }
                            if (!isArrayOfStrings(deletions)) {
                                // throw type error
                                throw {
                                    code: "T2012",
                                    stack: (new Error()).stack,
                                    position: expr.delete.position,
                                    value: val
                                };
                            }
                            for (var jj = 0; jj < deletions.length; jj++) {
                                if(typeof match === 'object' && match !== null) {
                                    delete match[deletions[jj]];
                                }
                            }
                        }
                    }
                }
            }

            return result;
        };

        return defineFunction(transformer, '<(oa):o>');
    }

    var chainAST = parser('function($f, $g) { function($x){ $g($f($x)) } }');

    /**
     * Apply the function on the RHS using the sequence on the LHS as the first argument
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    async function evaluateApplyExpression(expr, input, environment) {
        var result;


        var lhs = await evaluate(expr.lhs, input, environment);
        if(expr.rhs.type === 'function') {
            // this is a function _invocation_; invoke it with lhs expression as the first argument
            result = await evaluateFunction(expr.rhs, input, environment, { context: lhs });
        } else {
            var func = await evaluate(expr.rhs, input, environment);

            if(!isFunction(func)) {
                throw {
                    code: "T2006",
                    stack: (new Error()).stack,
                    position: expr.position,
                    value: func
                };
            }

            if(isFunction(lhs)) {
                // this is function chaining (func1 ~> func2)
                // λ($f, $g) { λ($x){ $g($f($x)) } }
                var chain = await evaluate(chainAST, null, environment);
                result = await apply(chain, [lhs, func], null, environment);
            } else {
                result = await apply(func, [lhs], null, environment);
            }

        }

        return result;
    }

    /**
     * Evaluate function against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    async function evaluateFunction(expr, input, environment, applyto) {
        var result;

        // create the procedure
        // can't assume that expr.procedure is a lambda type directly
        // could be an expression that evaluates to a function (e.g. variable reference, parens expr etc.
        // evaluate it generically first, then check that it is a function.  Throw error if not.
        var proc = await evaluate(expr.procedure, input, environment);

        if (typeof proc === 'undefined' && expr.procedure.type === 'path' && environment.lookup(expr.procedure.steps[0].value)) {
            // help the user out here if they simply forgot the leading $
            throw {
                code: "T1005",
                stack: (new Error()).stack,
                position: expr.position,
                token: expr.procedure.steps[0].value
            };
        }

        var evaluatedArgs = [];
        if(typeof applyto !== 'undefined') {
            evaluatedArgs.push(applyto.context);
        }
        // eager evaluation - evaluate the arguments
        for (var jj = 0; jj < expr.arguments.length; jj++) {
            const arg = await evaluate(expr.arguments[jj], input, environment);
            if(isFunction(arg)) {
                // wrap this in a closure
                const closure = async function (...params) {
                    // invoke func
                    return await apply(arg, params, null, environment);
                };
                closure.arity = getFunctionArity(arg);
                evaluatedArgs.push(closure);
            } else {
                evaluatedArgs.push(arg);
            }
        }
        // apply the procedure
        var procName = expr.procedure.type === 'path' ? expr.procedure.steps[0].value : expr.procedure.value;
        try {
            if(typeof proc === 'object') {
                proc.token = procName;
                proc.position = expr.position;
            }
            result = await apply(proc, evaluatedArgs, input, environment);
        } catch (err) {
            if(!err.position) {
                // add the position field to the error
                err.position = expr.position;
            }
            if (!err.token) {
                // and the function identifier
                err.token = procName;
            }
            throw err;
        }
        return result;
    }

    /**
     * Apply procedure or function
     * @param {Object} proc - Procedure
     * @param {Array} args - Arguments
     * @param {Object} input - input
     * @param {Object} environment - environment
     * @returns {*} Result of procedure
     */
    async function apply(proc, args, input, environment) {
        var result;
        result = await applyInner(proc, args, input, environment);
        while(isLambda(result) && result.thunk === true) {
            // trampoline loop - this gets invoked as a result of tail-call optimization
            // the function returned a tail-call thunk
            // unpack it, evaluate its arguments, and apply the tail call
            var next = await evaluate(result.body.procedure, result.input, result.environment);
            if(result.body.procedure.type === 'variable') {
                next.token = result.body.procedure.value;
            }
            next.position = result.body.procedure.position;
            var evaluatedArgs = [];
            for(var ii = 0; ii < result.body.arguments.length; ii++) {
                evaluatedArgs.push(await evaluate(result.body.arguments[ii], result.input, result.environment));
            }

            result = await applyInner(next, evaluatedArgs, input, environment);
        }
        return result;
    }

    /**
     * Apply procedure or function
     * @param {Object} proc - Procedure
     * @param {Array} args - Arguments
     * @param {Object} input - input
     * @param {Object} environment - environment
     * @returns {*} Result of procedure
     */
    async function applyInner(proc, args, input, environment) {
        var result;
        try {
            var validatedArgs = args;
            if (proc) {
                validatedArgs = validateArguments(proc.signature, args, input);
            }

            if (isLambda(proc)) {
                result = await applyProcedure(proc, validatedArgs);
            } else if (proc && proc._jsonata_function === true) {
                var focus = {
                    environment: environment,
                    input: input
                };
                // the `focus` is passed in as the `this` for the invoked function
                result = proc.implementation.apply(focus, validatedArgs);
                // `proc.implementation` might be a generator function
                // and `result` might be a generator - if so, yield
                if (isIterable(result)) {
                    result = result.next().value;
                }
                if (isPromise(result)) {
                    result = await result;
                }
            } else if (typeof proc === 'function') {
                // typically these are functions that are returned by the invocation of plugin functions
                // the `input` is being passed in as the `this` for the invoked function
                // this is so that functions that return objects containing functions can chain
                // e.g. await (await $func())
                result = proc.apply(input, validatedArgs);
                if (isPromise(result)) {
                    result = await result;
                }
            } else {
                throw {
                    code: "T1006",
                    stack: (new Error()).stack
                };
            }
        } catch(err) {
            if(proc) {
                if (typeof err.token == 'undefined' && typeof proc.token !== 'undefined') {
                    err.token = proc.token;
                }
                err.position = proc.position || err.position;
            }
            throw err;
        }
        return result;
    }

    /**
     * Evaluate lambda against input data
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {{lambda: boolean, input: *, environment: *, arguments: *, body: *}} Evaluated input data
     */
    function evaluateLambda(expr, input, environment) {
        // make a function (closure)
        var procedure = {
            _jsonata_lambda: true,
            input: input,
            environment: environment,
            arguments: expr.arguments,
            signature: expr.signature,
            body: expr.body
        };
        if(expr.thunk === true) {
            procedure.thunk = true;
        }
        procedure.apply = async function(self, args) {
            return await apply(procedure, args, input, !!self ? self.environment : environment);
        };
        return procedure;
    }

    /**
     * Evaluate partial application
     * @param {Object} expr - JSONata expression
     * @param {Object} input - Input data to evaluate against
     * @param {Object} environment - Environment
     * @returns {*} Evaluated input data
     */
    async function evaluatePartialApplication(expr, input, environment) {
        // partially apply a function
        var result;
        // evaluate the arguments
        var evaluatedArgs = [];
        for(var ii = 0; ii < expr.arguments.length; ii++) {
            var arg = expr.arguments[ii];
            if (arg.type === 'operator' && arg.value === '?') {
                evaluatedArgs.push(arg);
            } else {
                evaluatedArgs.push(await evaluate(arg, input, environment));
            }
        }
        // lookup the procedure
        var proc = await evaluate(expr.procedure, input, environment);
        if (typeof proc === 'undefined' && expr.procedure.type === 'path' && environment.lookup(expr.procedure.steps[0].value)) {
            // help the user out here if they simply forgot the leading $
            throw {
                code: "T1007",
                stack: (new Error()).stack,
                position: expr.position,
                token: expr.procedure.steps[0].value
            };
        }
        if (isLambda(proc)) {
            result = partialApplyProcedure(proc, evaluatedArgs);
        } else if (proc && proc._jsonata_function === true) {
            result = partialApplyNativeFunction(proc.implementation, evaluatedArgs);
        } else if (typeof proc === 'function') {
            result = partialApplyNativeFunction(proc, evaluatedArgs);
        } else {
            throw {
                code: "T1008",
                stack: (new Error()).stack,
                position: expr.position,
                token: expr.procedure.type === 'path' ? expr.procedure.steps[0].value : expr.procedure.value
            };
        }
        return result;
    }

    /**
     * Validate the arguments against the signature validator (if it exists)
     * @param {Function} signature - validator function
     * @param {Array} args - function arguments
     * @param {*} context - context value
     * @returns {Array} - validated arguments
     */
    function validateArguments(signature, args, context) {
        if(typeof signature === 'undefined') {
            // nothing to validate
            return args;
        }
        var validatedArgs = signature.validate(args, context);
        return validatedArgs;
    }

    /**
     * Apply procedure
     * @param {Object} proc - Procedure
     * @param {Array} args - Arguments
     * @returns {*} Result of procedure
     */
    async function applyProcedure(proc, args) {
        var result;
        var env = createFrame(proc.environment);
        proc.arguments.forEach(function (param, index) {
            env.bind(param.value, args[index]);
        });
        if (typeof proc.body === 'function') {
            // this is a lambda that wraps a native function - generated by partially evaluating a native
            result = await applyNativeFunction(proc.body, env);
        } else {
            result = await evaluate(proc.body, proc.input, env);
        }
        return result;
    }

    /**
     * Partially apply procedure
     * @param {Object} proc - Procedure
     * @param {Array} args - Arguments
     * @returns {{lambda: boolean, input: *, environment: {bind, lookup}, arguments: Array, body: *}} Result of partially applied procedure
     */
    function partialApplyProcedure(proc, args) {
        // create a closure, bind the supplied parameters and return a function that takes the remaining (?) parameters
        var env = createFrame(proc.environment);
        var unboundArgs = [];
        proc.arguments.forEach(function (param, index) {
            var arg = args[index];
            if (arg && arg.type === 'operator' && arg.value === '?') {
                unboundArgs.push(param);
            } else {
                env.bind(param.value, arg);
            }
        });
        var procedure = {
            _jsonata_lambda: true,
            input: proc.input,
            environment: env,
            arguments: unboundArgs,
            body: proc.body
        };
        return procedure;
    }

    /**
     * Partially apply native function
     * @param {Function} native - Native function
     * @param {Array} args - Arguments
     * @returns {{lambda: boolean, input: *, environment: {bind, lookup}, arguments: Array, body: *}} Result of partially applying native function
     */
    function partialApplyNativeFunction(native, args) {
        // create a lambda function that wraps and invokes the native function
        // get the list of declared arguments from the native function
        // this has to be picked out from the toString() value
        var sigArgs = getNativeFunctionArguments(native);
        sigArgs = sigArgs.map(function (sigArg) {
            return '$' + sigArg.trim();
        });
        var body = 'function(' + sigArgs.join(', ') + '){ _ }';

        var bodyAST = parser(body);
        bodyAST.body = native;

        var partial = partialApplyProcedure(bodyAST, args);
        return partial;
    }

    /**
     * Apply native function
     * @param {Object} proc - Procedure
     * @param {Object} env - Environment
     * @returns {*} Result of applying native function
     */
    async function applyNativeFunction(proc, env) {
        var sigArgs = getNativeFunctionArguments(proc);
        // generate the array of arguments for invoking the function - look them up in the environment
        var args = sigArgs.map(function (sigArg) {
            return env.lookup(sigArg.trim());
        });

        var focus = {
            environment: env
        };
        var result = proc.apply(focus, args);
        if (isPromise(result)) {
            result = await result;
        }
        return result;
    }

    /**
     * Get native function arguments
     * @param {Function} func - Function
     * @returns {*|Array} Native function arguments
     */
    function getNativeFunctionArguments(func) {
        var signature = func.toString();
        var sigParens = /\(([^)]*)\)/.exec(signature)[1]; // the contents of the parens
        var sigArgs = sigParens.split(',');
        return sigArgs;
    }

    /**
     * Creates a function definition
     * @param {Function} func - function implementation in Javascript
     * @param {string} signature - JSONata function signature definition
     * @returns {{implementation: *, signature: *}} function definition
     */
    function defineFunction(func, signature) {
        var definition = {
            _jsonata_function: true,
            implementation: func
        };
        if(typeof signature !== 'undefined') {
            definition.signature = parseSignature(signature);
        }
        return definition;
    }


    /**
     * parses and evaluates the supplied expression
     * @param {string} expr - expression to evaluate
     * @returns {*} - result of evaluating the expression
     */
    async function functionEval(expr, focus) {
        // undefined inputs always return undefined
        if(typeof expr === 'undefined') {
            return undefined;
        }
        var input = this.input;
        if(typeof focus !== 'undefined') {
            input = focus;
            // if the input is a JSON array, then wrap it in a singleton sequence so it gets treated as a single input
            if(Array.isArray(input) && !isSequence(input)) {
                input = createSequence(input);
                input.outerWrapper = true;
            }
        }

        try {
            var ast = parser(expr, false);
        } catch(err) {
            // error parsing the expression passed to $eval
            populateMessage(err);
            throw {
                stack: (new Error()).stack,
                code: "D3120",
                value: err.message,
                error: err
            };
        }
        try {
            var result = await evaluate(ast, input, this.environment);
        } catch(err) {
            // error evaluating the expression passed to $eval
            populateMessage(err);
            throw {
                stack: (new Error()).stack,
                code: "D3121",
                value:err.message,
                error: err
            };
        }

        return result;
    }

    /**
     * Clones an object
     * @param {Object} arg - object to clone (deep copy)
     * @returns {*} - the cloned object
     */
    function functionClone(arg) {
        // undefined inputs always return undefined
        if(typeof arg === 'undefined') {
            return undefined;
        }

        return JSON.parse(fn.string(arg));
    }

    /**
     * Create frame
     * @param {Object} enclosingEnvironment - Enclosing environment
     * @returns {{bind: bind, lookup: lookup}} Created frame
     */
    function createFrame(enclosingEnvironment) {
        var bindings = {};
        const newFrame = {
            bind: function (name, value) {
                bindings[name] = value;
            },
            lookup: function (name) {
                var value;
                if(bindings.hasOwnProperty(name)) {
                    value = bindings[name];
                } else if (enclosingEnvironment) {
                    value = enclosingEnvironment.lookup(name);
                }
                return value;
            },
            timestamp: enclosingEnvironment ? enclosingEnvironment.timestamp : null,
            async: enclosingEnvironment ? enclosingEnvironment.async : false,
            isParallelCall: enclosingEnvironment ? enclosingEnvironment.isParallelCall : false,
            global: enclosingEnvironment ? enclosingEnvironment.global : {
                ancestry: [ null ]
            }
        };

        if (enclosingEnvironment) {
            var framePushCallback = enclosingEnvironment.lookup(Symbol.for('jsonata.__createFrame_push'));
            if(framePushCallback) {
                framePushCallback(enclosingEnvironment, newFrame);
            }
        }
       

        return newFrame
    }

    // Function registration
    staticFrame.bind('sum', defineFunction(fn.sum, '<a<n>:n>'));
    staticFrame.bind('count', defineFunction(fn.count, '<a:n>'));
    staticFrame.bind('max', defineFunction(fn.max, '<a<n>:n>'));
    staticFrame.bind('min', defineFunction(fn.min, '<a<n>:n>'));
    staticFrame.bind('average', defineFunction(fn.average, '<a<n>:n>'));
    staticFrame.bind('string', defineFunction(fn.string, '<x-b?:s>'));
    staticFrame.bind('substring', defineFunction(fn.substring, '<s-nn?:s>'));
    staticFrame.bind('substringBefore', defineFunction(fn.substringBefore, '<s-s:s>'));
    staticFrame.bind('substringAfter', defineFunction(fn.substringAfter, '<s-s:s>'));
    staticFrame.bind('lowercase', defineFunction(fn.lowercase, '<s-:s>'));
    staticFrame.bind('uppercase', defineFunction(fn.uppercase, '<s-:s>'));
    staticFrame.bind('length', defineFunction(fn.length, '<s-:n>'));
    staticFrame.bind('trim', defineFunction(fn.trim, '<s-:s>'));
    staticFrame.bind('pad', defineFunction(fn.pad, '<s-ns?:s>'));
    staticFrame.bind('match', defineFunction(fn.match, '<s-f<s:o>n?:a<o>>'));
    staticFrame.bind('contains', defineFunction(fn.contains, '<s-(sf):b>')); // TODO <s-(sf<s:o>):b>
    staticFrame.bind('replace', defineFunction(fn.replace, '<s-(sf)(sf)n?:s>')); // TODO <s-(sf<s:o>)(sf<o:s>)n?:s>
    staticFrame.bind('split', defineFunction(fn.split, '<s-(sf)n?:a<s>>')); // TODO <s-(sf<s:o>)n?:a<s>>
    staticFrame.bind('join', defineFunction(fn.join, '<a<s>s?:s>'));
    staticFrame.bind('formatNumber', defineFunction(fn.formatNumber, '<n-so?:s>'));
    staticFrame.bind('formatBase', defineFunction(fn.formatBase, '<n-n?:s>'));
    staticFrame.bind('formatInteger', defineFunction(datetime.formatInteger, '<n-s:s>'));
    staticFrame.bind('parseInteger', defineFunction(datetime.parseInteger, '<s-s:n>'));
    staticFrame.bind('number', defineFunction(fn.number, '<(nsb)-:n>'));
    staticFrame.bind('floor', defineFunction(fn.floor, '<n-:n>'));
    staticFrame.bind('ceil', defineFunction(fn.ceil, '<n-:n>'));
    staticFrame.bind('round', defineFunction(fn.round, '<n-n?:n>'));
    staticFrame.bind('abs', defineFunction(fn.abs, '<n-:n>'));
    staticFrame.bind('sqrt', defineFunction(fn.sqrt, '<n-:n>'));
    staticFrame.bind('power', defineFunction(fn.power, '<n-n:n>'));
    staticFrame.bind('random', defineFunction(fn.random, '<:n>'));
    staticFrame.bind('boolean', defineFunction(fn.boolean, '<x-:b>'));
    staticFrame.bind('not', defineFunction(fn.not, '<x-:b>'));
    staticFrame.bind('map', defineFunction(fn.map, '<af>'));
    staticFrame.bind('zip', defineFunction(fn.zip, '<a+>'));
    staticFrame.bind('filter', defineFunction(fn.filter, '<af>'));
    staticFrame.bind('single', defineFunction(fn.single, '<af?>'));
    staticFrame.bind('reduce', defineFunction(fn.foldLeft, '<afj?:j>')); // TODO <f<jj:j>a<j>j?:j>
    staticFrame.bind('sift', defineFunction(fn.sift, '<o-f?:o>'));
    staticFrame.bind('keys', defineFunction(fn.keys, '<x-:a<s>>'));
    staticFrame.bind('lookup', defineFunction(fn.lookup, '<x-s:x>'));
    staticFrame.bind('append', defineFunction(fn.append, '<xx:a>'));
    staticFrame.bind('exists', defineFunction(fn.exists, '<x:b>'));
    staticFrame.bind('spread', defineFunction(fn.spread, '<x-:a<o>>'));
    staticFrame.bind('merge', defineFunction(fn.merge, '<a<o>:o>'));
    staticFrame.bind('reverse', defineFunction(fn.reverse, '<a:a>'));
    staticFrame.bind('each', defineFunction(fn.each, '<o-f:a>'));
    staticFrame.bind('error', defineFunction(fn.error, '<s?:x>'));
    staticFrame.bind('assert', defineFunction(fn.assert, '<bs?:x>'));
    staticFrame.bind('type', defineFunction(fn.type, '<x:s>'));
    staticFrame.bind('sort', defineFunction(fn.sort, '<af?:a>'));
    staticFrame.bind('shuffle', defineFunction(fn.shuffle, '<a:a>'));
    staticFrame.bind('distinct', defineFunction(fn.distinct, '<x:x>'));
    staticFrame.bind('base64encode', defineFunction(fn.base64encode, '<s-:s>'));
    staticFrame.bind('base64decode', defineFunction(fn.base64decode, '<s-:s>'));
    staticFrame.bind('encodeUrlComponent', defineFunction(fn.encodeUrlComponent, '<s-:s>'));
    staticFrame.bind('encodeUrl', defineFunction(fn.encodeUrl, '<s-:s>'));
    staticFrame.bind('decodeUrlComponent', defineFunction(fn.decodeUrlComponent, '<s-:s>'));
    staticFrame.bind('decodeUrl', defineFunction(fn.decodeUrl, '<s-:s>'));
    staticFrame.bind('eval', defineFunction(functionEval, '<sx?:x>'));
    staticFrame.bind('toMillis', defineFunction(datetime.toMillis, '<s-s?:n>'));
    staticFrame.bind('fromMillis', defineFunction(datetime.fromMillis, '<n-s?s?:s>'));
    staticFrame.bind('clone', defineFunction(functionClone, '<(oa)-:o>'));

    /**
     * Error codes
     *
     * Sxxxx    - Static errors (compile time)
     * Txxxx    - Type errors
     * Dxxxx    - Dynamic errors (evaluate time)
     *  01xx    - tokenizer
     *  02xx    - parser
     *  03xx    - regex parser
     *  04xx    - function signature parser/evaluator
     *  10xx    - evaluator
     *  20xx    - operators
     *  3xxx    - functions (blocks of 10 for each function)
     */
    var errorCodes = {
        "S0101": "String literal must be terminated by a matching quote",
        "S0102": "Number out of range: {{token}}",
        "S0103": "Unsupported escape sequence: \\{{token}}",
        "S0104": "The escape sequence \\u must be followed by 4 hex digits",
        "S0105": "Quoted property name must be terminated with a backquote (`)",
        "S0106": "Comment has no closing tag",
        "S0201": "Syntax error: {{token}}",
        "S0202": "Expected {{value}}, got {{token}}",
        "S0203": "Expected {{value}} before end of expression",
        "S0204": "Unknown operator: {{token}}",
        "S0205": "Unexpected token: {{token}}",
        "S0206": "Unknown expression type: {{token}}",
        "S0207": "Unexpected end of expression",
        "S0208": "Parameter {{value}} of function definition must be a variable name (start with $)",
        "S0209": "A predicate cannot follow a grouping expression in a step",
        "S0210": "Each step can only have one grouping expression",
        "S0211": "The symbol {{token}} cannot be used as a unary operator",
        "S0212": "The left side of := must be a variable name (start with $)",
        "S0213": "The literal value {{value}} cannot be used as a step within a path expression",
        "S0214": "The right side of {{token}} must be a variable name (start with $)",
        "S0215": "A context variable binding must precede any predicates on a step",
        "S0216": "A context variable binding must precede the 'order-by' clause on a step",
        "S0217": "The object representing the 'parent' cannot be derived from this expression",
        "S0301": "Empty regular expressions are not allowed",
        "S0302": "No terminating / in regular expression",
        "S0402": "Choice groups containing parameterized types are not supported",
        "S0401": "Type parameters can only be applied to functions and arrays",
        "S0500": "Attempted to evaluate an expression containing syntax error(s)",
        "T0410": "Argument {{index}} of function {{token}} does not match function signature",
        "T0411": "Context value is not a compatible type with argument {{index}} of function {{token}}",
        "T0412": "Argument {{index}} of function {{token}} must be an array of {{type}}",
        "D1001": "Number out of range: {{value}}",
        "D1002": "Cannot negate a non-numeric value: {{value}}",
        "T1003": "Key in object structure must evaluate to a string; got: {{value}}",
        "D1004": "Regular expression matches zero length string",
        "T1005": "Attempted to invoke a non-function. Did you mean ${{{token}}}?",
        "T1006": "Attempted to invoke a non-function",
        "T1007": "Attempted to partially apply a non-function. Did you mean ${{{token}}}?",
        "T1008": "Attempted to partially apply a non-function",
        "D1009": "Multiple key definitions evaluate to same key: {{value}}",
        "D1010": "Attempted to access the Javascript object prototype", // Javascript specific 
        "T1010": "The matcher function argument passed to function {{token}} does not return the correct object structure",
        "T2001": "The left side of the {{token}} operator must evaluate to a number",
        "T2002": "The right side of the {{token}} operator must evaluate to a number",
        "T2003": "The left side of the range operator (..) must evaluate to an integer",
        "T2004": "The right side of the range operator (..) must evaluate to an integer",
        "D2005": "The left side of := must be a variable name (start with $)",  // defunct - replaced by S0212 parser error
        "T2006": "The right side of the function application operator ~> must be a function",
        "T2007": "Type mismatch when comparing values {{value}} and {{value2}} in order-by clause",
        "T2008": "The expressions within an order-by clause must evaluate to numeric or string values",
        "T2009": "The values {{value}} and {{value2}} either side of operator {{token}} must be of the same data type",
        "T2010": "The expressions either side of operator {{token}} must evaluate to numeric or string values",
        "T2011": "The insert/update clause of the transform expression must evaluate to an object: {{value}}",
        "T2012": "The delete clause of the transform expression must evaluate to a string or array of strings: {{value}}",
        "T2013": "The transform expression clones the input object using the $clone() function.  This has been overridden in the current scope by a non-function.",
        "D2014": "The size of the sequence allocated by the range operator (..) must not exceed 1e6.  Attempted to allocate {{value}}.",
        "D3001": "Attempting to invoke string function on Infinity or NaN",
        "D3010": "Second argument of replace function cannot be an empty string",
        "D3011": "Fourth argument of replace function must evaluate to a positive number",
        "D3012": "Attempted to replace a matched string with a non-string value",
        "D3020": "Third argument of split function must evaluate to a positive number",
        "D3030": "Unable to cast value to a number: {{value}}",
        "D3040": "Third argument of match function must evaluate to a positive number",
        "D3050": "The second argument of reduce function must be a function with at least two arguments",
        "D3060": "The sqrt function cannot be applied to a negative number: {{value}}",
        "D3061": "The power function has resulted in a value that cannot be represented as a JSON number: base={{value}}, exponent={{exp}}",
        "D3070": "The single argument form of the sort function can only be applied to an array of strings or an array of numbers.  Use the second argument to specify a comparison function",
        "D3080": "The picture string must only contain a maximum of two sub-pictures",
        "D3081": "The sub-picture must not contain more than one instance of the 'decimal-separator' character",
        "D3082": "The sub-picture must not contain more than one instance of the 'percent' character",
        "D3083": "The sub-picture must not contain more than one instance of the 'per-mille' character",
        "D3084": "The sub-picture must not contain both a 'percent' and a 'per-mille' character",
        "D3085": "The mantissa part of a sub-picture must contain at least one character that is either an 'optional digit character' or a member of the 'decimal digit family'",
        "D3086": "The sub-picture must not contain a passive character that is preceded by an active character and that is followed by another active character",
        "D3087": "The sub-picture must not contain a 'grouping-separator' character that appears adjacent to a 'decimal-separator' character",
        "D3088": "The sub-picture must not contain a 'grouping-separator' at the end of the integer part",
        "D3089": "The sub-picture must not contain two adjacent instances of the 'grouping-separator' character",
        "D3090": "The integer part of the sub-picture must not contain a member of the 'decimal digit family' that is followed by an instance of the 'optional digit character'",
        "D3091": "The fractional part of the sub-picture must not contain an instance of the 'optional digit character' that is followed by a member of the 'decimal digit family'",
        "D3092": "A sub-picture that contains a 'percent' or 'per-mille' character must not contain a character treated as an 'exponent-separator'",
        "D3093": "The exponent part of the sub-picture must comprise only of one or more characters that are members of the 'decimal digit family'",
        "D3100": "The radix of the formatBase function must be between 2 and 36.  It was given {{value}}",
        "D3110": "The argument of the toMillis function must be an ISO 8601 formatted timestamp. Given {{value}}",
        "D3120": "Syntax error in expression passed to function eval: {{value}}",
        "D3121": "Dynamic error evaluating the expression passed to function eval: {{value}}",
        "D3130": "Formatting or parsing an integer as a sequence starting with {{value}} is not supported by this implementation",
        "D3131": "In a decimal digit pattern, all digits must be from the same decimal group",
        "D3132": "Unknown component specifier {{value}} in date/time picture string",
        "D3133": "The 'name' modifier can only be applied to months and days in the date/time picture string, not {{value}}",
        "D3134": "The timezone integer format specifier cannot have more than four digits",
        "D3135": "No matching closing bracket ']' in date/time picture string",
        "D3136": "The date/time picture string is missing specifiers required to parse the timestamp",
        "D3137": "{{{message}}}",
        "D3138": "The $single() function expected exactly 1 matching result.  Instead it matched more.",
        "D3139": "The $single() function expected exactly 1 matching result.  Instead it matched 0.",
        "D3140": "Malformed URL passed to ${{{functionName}}}(): {{value}}",
        "D3141": "{{{message}}}"
    };

    /**
     * lookup a message template from the catalog and substitute the inserts.
     * Populates `err.message` with the substituted message. Leaves `err.message`
     * untouched if code lookup fails.
     * @param {string} err - error code to lookup
     * @returns {undefined} - `err` is modified in place
     */
    function populateMessage(err) {
        var template = errorCodes[err.code];
        if(typeof template !== 'undefined') {
            // if there are any handlebars, replace them with the field references
            // triple braces - replace with value
            // double braces - replace with json stringified value
            var message = template.replace(/\{\{\{([^}]+)}}}/g, function() {
                return err[arguments[1]];
            });
            message = message.replace(/\{\{([^}]+)}}/g, function() {
                return JSON.stringify(err[arguments[1]]);
            });
            err.message = message;
        }
        // Otherwise retain the original `err.message`
    }

    /**
     * JSONata
     * @param {Object} expr - JSONata expression
     * @param {Object} options
     * @param {boolean} options.recover: attempt to recover on parse error
     * @param {Function} options.RegexEngine: RegEx class constructor to use
     * @returns {{evaluate: evaluate, assign: assign}} Evaluated expression
     */
    function jsonata(expr, options) {
        var ast;
        var errors;
        try {
            ast = parser(expr, options && options.recover);
            errors = ast.errors;
            delete ast.errors;
        } catch(err) {
            // insert error message into structure
            populateMessage(err); // possible side-effects on `err`
            throw err;
        }
        var environment = createFrame(staticFrame);

        var timestamp = new Date(); // will be overridden on each call to evalute()
        environment.bind('now', defineFunction(function(picture, timezone) {
            return datetime.fromMillis(timestamp.getTime(), picture, timezone);
        }, '<s?s?:s>'));
        environment.bind('millis', defineFunction(function() {
            return timestamp.getTime();
        }, '<:n>'));

        if(options && options.RegexEngine) {
            jsonata.RegexEngine = options.RegexEngine;
        } else {
            jsonata.RegexEngine = RegExp;
        }

        return {
            evaluate: async function (input, bindings, callback) {
                // throw if the expression compiled with syntax errors
                if(typeof errors !== 'undefined') {
                    var err = {
                        code: 'S0500',
                        position: 0
                    };
                    populateMessage(err); // possible side-effects on `err`
                    throw err;
                }

                if (typeof bindings !== 'undefined') {
                    var exec_env;
                    // the variable bindings have been passed in - create a frame to hold these
                    exec_env = createFrame(environment);
                    for (var v in bindings) {
                        exec_env.bind(v, bindings[v]);
                    }
                } else {
                    exec_env = environment;
                }
                // put the input document into the environment as the root object
                exec_env.bind('$', input);

                // capture the timestamp and put it in the execution environment
                // the $now() and $millis() functions will return this value - whenever it is called
                timestamp = new Date();
                exec_env.timestamp = timestamp;

                // if the input is a JSON array, then wrap it in a singleton sequence so it gets treated as a single input
                if(Array.isArray(input) && !isSequence(input)) {
                    input = createSequence(input);
                    input.outerWrapper = true;
                }

                var it;
                try {
                    it = await evaluate(ast, input, exec_env);
                    if (typeof callback === "function") {
                        callback(null, it);
                    }
                    return it;
                } catch (err) {
                    // insert error message into structure
                    populateMessage(err); // possible side-effects on `err`
                    throw err;
                }
            },
            assign: function (name, value) {
                environment.bind(name, value);
            },
            registerFunction: function(name, implementation, signature) {
                var func = defineFunction(implementation, signature);
                environment.bind(name, func);
            },
            ast: function() {
                return ast;
            },
            errors: function() {
                return errors;
            }
        };
    }

    jsonata.parser = parser; // TODO remove this in a future release - use ast() instead

    return jsonata;

})();

module.exports = jsonata;
