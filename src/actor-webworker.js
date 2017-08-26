import { Worker } from 'webworker-threads';

const createActorWebworker = () => new Worker (
    function () {
        // Helper functions for type introspection
        Object.prototype.isType = function (t) { return t.name === Object.getPrototypeOf(this).constructor.name };
        Object.prototype.typeName = function () { return Object.getPrototypeOf(this).constructor.name; };


        const serializeErr = err => JSON.stringify(err, Object.getOwnPropertyNames(err));

        class Deferred {
            constructor() {
                this.promise = new Promise((resolve, reject) => {
                    this.reject = reject;
                    this.resolve = resolve;
                });
            }
        }

        class Queue {

            constructor() { }

            static empty() { return new Queue(); }

            enqueue(item) {
                const nextTail = { item };
                if (this.tail) {
                    let prevTail = this.tail;
                    prevTail.next = nextTail;
                    this.tail = nextTail;
                } else {
                    this.head = nextTail;
                    this.tail = nextTail;
                }
            }

            isEmpty() { return this.front !== undefined; }

            front() { return this.front ? this.front.item : undefined; }

            dequeue() {
                if (this.front) {
                    const item = this.front.item;
                    if (this.front !== this.tail) {
                        this.front = this.front.next;
                    } else {
                        mailbox.head = undefined;
                        mailbox.tail = undefined;
                    }
                    return item;
                } else {
                    throw new Error("Attempted illegal operation: Empty queue cannot be popped");
                }
            }
        }

        class RingBuffer {
            constructor(size) {
                this.size = size;
                this.arr = new Array(size);
                this.count = 0;
            };

            get(index) {
                return this.arr[index];
            }

            set(index, value) {
                this.arr[index] = value;
            }

            add(value) {
                let i = this.count;
                this.arr[i] = value;
                ++this.count;
                this.count = this.count >= this.size ? 0 : this.count;
                return i;
            }
        }

        let busy = false;
        let outstandingEffects = new RingBuffer(4048);
        let mailbox = Queue.empty();
        
        let f = undefined;        
        name = undefined;
        path = undefined;
        sender = undefined;
        parent = undefined;
        children = {};

        const processNext = (next) => {
            if (next.isType(Function)) {
                f = next;
                if (!mailbox.isEmpty()) {
                    let nextMessage = mailbox.dequeue();
                    handleMessage(nextMessage);
                } else {
                    busy = false;
                }
            } else if (next == undefined) {
                destroy();
            } else {
                throw new TypeError("Unsupported Type");
            }
        };

        const handleMessage = (msg) => {
            busy = true;            
            let next = undefined;            
            try {
                const _name = ''+name;
                const _path = Object.freeze(path);
                const _parent = Object.freeze(parent);                                
                const _children = Object.assign({}, children);

                sender = msg.payload.sender;      
                next = f.call({}, msg.payload.message);

                name = _name;
                path = _path;
                parent = _parent;
                children = _children;                                

            } catch (e) {
                signalFault(e);
                return;
            }

            if (next.isType(Promise)) {
                next.then(processNext).catch(signalFault);
            } else {
                processNext(next);
            }

        };

        const dispatchAsync = (action, args) => {
            let deferred = new Deferred();
            let index = outstandingEffects.add(deferred);
            self.postMessage({ action, args, sender: path, index });
            return deferred.promise;
        };

        const dispatch = (action, args) =>
            self.postMessage({ action, args, sender: path });

        const signalFault = (e) => {
            let error = serializeErr(e);
            self.postMessage({ action: 'faulted', payload: { sender: path, payload: { error } }, sender: path });
            self.close();
        };

        const destroy = () => {
            self.postMessage({ action: 'destroy', sender: path, args: [] });
            self.close();
        };

        const bindEffects = (effects) => {

            let mapFold = (name, length, async) => {
                let f = async
                    ? (...args) => dispatchAsync(name, args)
                    : (...args) => dispatch(name, args);

                return (effect, part, index) => {
                    let next = index + 1 === length
                        ? f
                        : (effect[part] || {});

                    effect[part] = next;
                    return next;
                };
            };

            effects
                .map(e => ({ parts: e.effect.split('.'), name: e.effect, async: e.async }))
                .map(e => e.parts.reduce(mapFold(e.name, e.parts.length, e.async), global));
        };


        self.onmessage = (evt) => {
            try {
                
                let message = evt.data;
                let payload = message.payload;
                switch (message.action) {
                    
                    case 'initialize': {
                        f = eval(payload.f)();                        
                        name = payload.name;
                        path = payload.path;
                        parent = payload.parent;                        
                        children = {};
                        bindEffects(payload.effects);
                        break;
                    }
                    case 'childSpawned': {                        
                        let nextChildren = {...children, ...{ [payload.name]: payload.child }};
                        children = nextChildren;
                        break;
                    }
                    case 'childDestroyed': {
                        let nextChildren = { ...children };
                        delete nextChildren[payload.child];
                        children = nextChildren;
                        break;
                    }
                    case 'effectApplied': {
                        let index = payload.index;
                        let effect = outstandingEffects.get(index);
                        outstandingEffects.set(index, undefined);
                        if (effect) {                            
                            effect.resolve(payload.value);
                        }
                        break;
                    }
                    case 'effectFailed': {
                        let index = payload.index;
                        let effect = outstandingEffects.get(index);
                        if (effect) {
                            effect.reject(payload.value);
                        }
                        break;
                    }
                    case 'tell': {                        
                        if (!busy) {
                            handleMessage(message);
                        } else {
                            mailbox.enqueue(message);
                        }
                        break;
                    }
                    case 'destroy': {
                        destroy();
                        break;
                    }
                }
            } catch (e) {
                signalFault(e);
            }
        };
    });


export default createActorWebworker;