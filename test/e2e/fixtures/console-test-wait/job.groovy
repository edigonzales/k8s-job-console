action('waitForCancel') {
    println 'waiting for cancellation'
    Thread.sleep(120_000)
}
defaults 'waitForCancel'
