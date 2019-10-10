"use strict";

var decoder;
var mainReadyResolve;
var mainReady = new Promise(function(resolve){ mainReadyResolve = resolve; });

global['onmessage'] = function( e ){
  mainReady.then(function(){
    switch( e['data']['command'] ){

      case 'decode':
        if (decoder){
          decoder.decode( e['data']['pages'] );
        }
        break;

      case 'done':
        if (decoder) {
          decoder.sendLastBuffer();
          global['close']();
        }
        break;

      case 'init':
        decoder = new OggOpusDecoder( e['data'], Module );
        break;

      default:
        // Ignore any unknown commands and continue recieving commands
    }
  });
};

var OggOpusDecoder = function( config, Module ){

  if ( !Module ) {
    throw new Error('Module with exports required to initialize a decoder instance');
  }

  this.mainReady = mainReady; // Expose for unit testing
  this.config = Object.assign({ 
    bufferLength: 4096, // Define size of outgoing buffer
    decoderSampleRate: 48000, // Desired decoder sample rate.
    outputBufferSampleRate: 48000, // Desired output sample rate. Audio will be resampled
    resampleQuality: 3, // Value between 0 and 10 inclusive. 10 being highest quality.
  }, config );

  this._opus_decoder_create = Module._opus_decoder_create;
  this._opus_decoder_destroy = Module._opus_decoder_destroy;
  this._speex_resampler_process_interleaved_float = Module._speex_resampler_process_interleaved_float;
  this._speex_resampler_init = Module._speex_resampler_init;
  this._speex_resampler_destroy = Module._speex_resampler_destroy;
  this._opus_decode_float = Module._opus_decode_float;
  this._free = Module._free;
  this._malloc = Module._malloc;
  this.HEAPU8 = Module.HEAPU8;
  this.HEAP32 = Module.HEAP32;
  this.HEAPF32 = Module.HEAPF32;

  this.outputBuffers = [];

  this.init();
};


OggOpusDecoder.prototype.decode = function( typedArray ) {
  this.decoderBuffer.set(typedArray);
  var outputSampleLength = this._opus_decode_float( this.decoder, this.decoderBufferPointer, typedArray.length, this.decoderOutputPointer, this.decoderOutputMaxLength, 0);
  if(outputSampleLength < 0){
    throw 'decode error:' + outputSampleLength;
  }
  this.sendToOutputBuffers( this.HEAPF32.subarray( this.decoderOutputPointer >> 2, (this.decoderOutputPointer >> 2) + outputSampleLength * this.numberOfChannels ) );
};

OggOpusDecoder.prototype.init = function(){
  this.numberOfChannels = this.config.numberOfChannels;
  this.resetOutputBuffers();
  this.initCodec();
  //this.initResampler();
};

OggOpusDecoder.prototype.initCodec = function() {
  if ( this.decoder ) {
    this._opus_decoder_destroy( this.decoder );
    this._free( this.decoderBufferPointer );
    this._free( this.decoderOutputLengthPointer );
    this._free( this.decoderOutputPointer );
  }

  var errReference = this._malloc( 4 );
  this.decoder = this._opus_decoder_create( this.config.decoderSampleRate, this.numberOfChannels, errReference );
  this._free( errReference );

  this.decoderBufferMaxLength = 4000;
  this.decoderBufferPointer = this._malloc( this.decoderBufferMaxLength );
  this.decoderBuffer = this.HEAPU8.subarray( this.decoderBufferPointer, this.decoderBufferPointer + this.decoderBufferMaxLength );
  this.decoderBufferIndex = 0;

  this.decoderOutputLengthPointer = this._malloc( 4 );
  this.decoderOutputMaxLength = this.config.decoderSampleRate * this.numberOfChannels * 120 / 1000; // Max 120ms frame size
  this.decoderOutputPointer = this._malloc( this.decoderOutputMaxLength * 4 ); // 4 bytes per sample
};

OggOpusDecoder.prototype.initResampler = function() {

  if ( this.resampler ) {
    this._speex_resampler_destroy( this.resampler );
    this._free( this.resampleOutputLengthPointer );
    this._free( this.resampleOutputBufferPointer );
  }

  var errLocation = this._malloc( 4 );
  this.resampler = this._speex_resampler_init( this.numberOfChannels, this.config.decoderSampleRate, this.config.outputBufferSampleRate, this.config.resampleQuality, errLocation );
  this._free( errLocation );

  this.resampleOutputLengthPointer = this._malloc( 4 );
  this.resampleOutputMaxLength = Math.ceil( this.decoderOutputMaxLength * this.config.outputBufferSampleRate / this.config.decoderSampleRate );
  this.resampleOutputBufferPointer = this._malloc( this.resampleOutputMaxLength * 4 ); // 4 bytes per sample
};

OggOpusDecoder.prototype.resetOutputBuffers = function(){
  this.outputBuffers = [];
  this.outputBufferArrayBuffers = [];
  this.outputBufferIndex = 0;

  for ( var i = 0; i < this.numberOfChannels; i++ ) {
    this.outputBuffers.push( new Float32Array( this.config.bufferLength ) );
    this.outputBufferArrayBuffers.push( this.outputBuffers[i].buffer );
  }
};

OggOpusDecoder.prototype.sendLastBuffer = function(){
  this.sendToOutputBuffers( new Float32Array( ( this.config.bufferLength - this.outputBufferIndex ) * this.numberOfChannels ) );
  global['postMessage'](null);
};

OggOpusDecoder.prototype.sendToOutputBuffers = function( mergedBuffers ){
  var dataIndex = 0;
  var mergedBufferLength = mergedBuffers.length / this.numberOfChannels;

  while ( dataIndex < mergedBufferLength ) {
    var amountToCopy = Math.min( mergedBufferLength - dataIndex, this.config.bufferLength - this.outputBufferIndex );

    if (this.numberOfChannels === 1) {
      this.outputBuffers[0].set( mergedBuffers.subarray( dataIndex, dataIndex + amountToCopy ), this.outputBufferIndex );
    }

    // Deinterleave
    else {
      for ( var i = 0; i < amountToCopy; i++ ) {
        this.outputBuffers.forEach( function( buffer, channelIndex ) {
          buffer[ this.outputBufferIndex + i ] = mergedBuffers[ ( dataIndex + i ) * this.numberOfChannels + channelIndex ];
        }, this);
      }
    }

    dataIndex += amountToCopy;
    this.outputBufferIndex += amountToCopy;

    if ( this.outputBufferIndex == this.config.bufferLength ) {
      global['postMessage']( this.outputBuffers, this.outputBufferArrayBuffers );
      this.resetOutputBuffers();
    }
  }
};


if (!Module) {
  Module = {};
}

Module['mainReady'] = mainReady;
Module['OggOpusDecoder'] = OggOpusDecoder;
Module['onRuntimeInitialized'] = mainReadyResolve;

module.exports = Module;
