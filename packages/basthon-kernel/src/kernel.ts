import { KernelMessage } from '@jupyterlab/services';

import { BaseKernel, IKernel } from '@jupyterlite/kernel';

import { PromiseDelegate } from '@lumino/coreutils';

/* eslint-disable */
declare global {
  interface Window {
    Basthon: any;
    domNodeBus: any;
  }
}
/* eslint-enable */

/**
 * DOM node variable exchanger (Bus) to bypass stringifying
 * messages between frontend and kernel that prevents DOMNode sharing.
 */
class DomNodeBus {
  //constructor() {}

  /**
   * Pushing a variable to the bus and getting an id to pop it.
   */
  push(obj: any): number {
    const id = ++this._count;
    this._bus.set(id, obj);
    return id;
  }

  /**
   * Removing a variable from the bus from its id.
   */
  pop(id: number): any {
    const res = this._bus.get(id);
    this._bus.delete(id);
    return res;
  }

  /**
   * The actual bus is a Map.
   */
  private _bus = new Map();
  private _count = 0;
}

/**
 * A kernel that executes Python code with Basthon.
 */
export class BasthonKernel extends BaseKernel implements IKernel {
  /**
   * Instantiate a new BasthonKernel
   *
   * @param options The instantiation options for a new Kernel
   */
  constructor(options: BasthonKernel.IOptions) {
    super(options);
    this.init();
  }

  async init(): Promise<void> {
    function loadScript(url: string) {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.onload = resolve;
        script.onerror = reject;
        script.src = url;
        document.head.appendChild(script);
      });
    }
    await loadScript('./basthon-kernel/basthon-python3.min.js');
    this.Basthon = window.Basthon;
    await this.Basthon.init();

    this.Basthon.addEventListener('eval.finished', (data: any) => {
      const bundle = { data: {}, metadata: {} };
      if ('result' in data) {
        bundle.data = data.result;
      }
      this._executeDelegate.resolve(bundle);
    });

    this.Basthon.addEventListener('eval.error', (data: any) => {
      const parentHeader = this.parentHeader;
      this._executeDelegate.resolve({ ...data, parentHeader });
    });

    this.Basthon.addEventListener('eval.output', (data: any) => {
      const parentHeader = this.parentHeader;
      const content = {
        event: 'stream',
        name: data.stream,
        parentHeader,
        text: data.content
      } as KernelMessage.IStreamMsg['content'];
      this.stream(content);
    });

    window.domNodeBus = this.domNodeBus;
    this.Basthon.addEventListener('eval.display', (data: any) => {
      /* see outputarea.js to understand interaction */
      let send_data, root, id, domid;
      switch (data.display_type) {
        case 'html':
          send_data = { 'text/html': data.content };
          break;
        case 'sympy':
          send_data = { 'text/latex': data.content };
          break;
        case 'turtle':
          root = data.content;
          root.setAttribute('width', '480px');
          root.setAttribute('height', '360px');
          //send_data = { 'image/svg+xml': root.outerHTML };
          send_data = { 'text/html': root.outerHTML };
          break;
        case 'matplotlib':
        case 'p5':
          /* /!\ big hack /!\
             To allow javascript loading of DOM node,
             we get an id identifying the object. We can then
             pickup the object from its id.
          */
          id = this.domNodeBus.push(data.content);
          /*    
          send_data = {
            'application/javascript':
              'element.append(window.domNodeBus.pop(' + id + '));'
              };*/
          domid = `basthon-output-${id}`;
          send_data = {
            'text/html': `<div id="${domid}"></div><script>document.getElementById("${domid}").append(window.domNodeBus.pop(${id}));</script>`
          };
          break;
        case 'multiple':
          /* typically dispached by display() */
          send_data = data.content;
          break;
        case 'tutor':
          send_data = { 'text/html': data.content };
          break;
        default:
          console.error('Not recognized display_type: ' + data.display_type);
      }

      this.displayData({ data: send_data, metadata: {} });
    });

    this._ready.resolve();
  }

  /**
   * Dispose the kernel.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    super.dispose();
  }

  /**
   * A promise that is fulfilled when the kernel is ready.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * Handle a kernel_info_request message
   */
  async kernelInfoRequest(): Promise<KernelMessage.IInfoReplyMsg['content']> {
    const content: KernelMessage.IInfoReply = {
      implementation: 'pyodide',
      implementation_version: '0.1.0',
      language_info: {
        codemirror_mode: {
          name: 'python',
          version: 3
        },
        file_extension: '.py',
        mimetype: 'text/x-python',
        name: 'python',
        nbconvert_exporter: 'python',
        pygments_lexer: 'ipython3',
        version: '3.8'
      },
      protocol_version: '5.3',
      status: 'ok',
      banner: 'Basthon: A WebAssembly-powered Python kernel backed by Pyodide',
      help_links: [
        {
          text: 'Python (WASM) Kernel',
          url: 'https://basthon.fr'
        }
      ]
    };
    return content;
  }

  /**
   * Handle an `execute_request` message
   *
   * @param msg The parent message.
   */
  async executeRequest(
    content: KernelMessage.IExecuteRequestMsg['content']
  ): Promise<KernelMessage.IExecuteResultMsg['content']> {
    const { code } = content;
    const result = await this._eval(code);
    if (result.name) {
      throw result;
    }
    // TODO: move executeResult and executeError here
    return {
      execution_count: this.executionCount,
      ...result
    };
  }

  /**
   * Handle an complete_request message
   *
   * @param msg The parent message.
   */
  async completeRequest(
    content: KernelMessage.ICompleteRequestMsg['content']
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    let completions = this.Basthon.complete(content.code);
    const cursor_start = completions[1];
    completions = completions[0];
    return {
      matches: completions,
      cursor_start: cursor_start,
      cursor_end: content.cursor_pos,
      metadata: {},
      status: 'ok'
    };
  }

  /**
   * Handle an `inspect_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async inspectRequest(
    content: KernelMessage.IInspectRequestMsg['content']
  ): Promise<KernelMessage.IInspectReplyMsg['content']> {
    throw new Error('Not implemented');
  }

  /**
   * Handle an `is_complete_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async isCompleteRequest(
    content: KernelMessage.IIsCompleteRequestMsg['content']
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    throw new Error('Not implemented');
  }

  /**
   * Handle a `comm_info_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async commInfoRequest(
    content: KernelMessage.ICommInfoRequestMsg['content']
  ): Promise<KernelMessage.ICommInfoReplyMsg['content']> {
    throw new Error('Not implemented');
  }

  /**
   * Send an `input_request` message.
   *
   * @param content - The content of the request.
   */
  async inputRequest(
    content: KernelMessage.IInputRequestMsg['content']
  ): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Send code to be executed in the web worker
   *
   * @param code The code to execute.
   */
  private async _eval(code: string): Promise<any> {
    this._executeDelegate = new PromiseDelegate<any>();
    this.Basthon.dispatchEvent('eval.request', { code: code });
    return await this._executeDelegate.promise;
  }

  private _executeDelegate = new PromiseDelegate<any>();
  private _ready = new PromiseDelegate<void>();
  private Basthon: any;
  private domNodeBus = new DomNodeBus();
}

/**
 * A namespace for BasthonKernel statics.
 */
export namespace BasthonKernel {
  /**
   * The instantiation options for a Pyodide kernel
   */
  export interface IOptions extends IKernel.IOptions {}
}
